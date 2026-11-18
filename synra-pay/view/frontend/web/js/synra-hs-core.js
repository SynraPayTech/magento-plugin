/* ─────────────────────────────────────────────────────────────────────────────
   SynraPay hosted session on the Magento checkout (window.SynraHS).

     store (POST synra/hs/session)   → Direct API create-order + hosted-session
     page                            → hosted-session.js  SynraHostedSession.mount({ clientToken, container })
     "Place Order"                   → Magento creates the order (pending_payment), answers its id
     page                            → session.pay()  (card goes frame → SynraPay, 3-DS over the page)
     store (POST synra/hs/confirm)   → GET /direct/payment/{order_id}/status decides → success page

   The card is typed into SynraPay's frame. This script, the page and the store
   never receive it. Only the ORDER's status (read by the store) settles the
   Magento order; nothing the frame says about the outcome is trusted.
   ───────────────────────────────────────────────────────────────────────────── */
define(['jquery', 'mage/cookies'], function ($) {
    'use strict';

    if (window.SynraHS) {
        return window.SynraHS;
    }
    var w = window, d = document;
    var cfg = (w.checkoutConfig && w.checkoutConfig.payment && w.checkoutConfig.payment.synra_pay) || {};
    var i18n = cfg.i18n || {};

    var state = {
        sdkPromise: null,
        fields: null,         // the mounted session: { pay(), destroy() }
        session: null,        // { clientToken, orderId, merchantOrderId, amount, currency, expiresAt }
        container: null,
        key: '',              // what the current session was opened for (customer + total)
        customer: null,       // the last customer details given to sync()
        complete: false,      // the frame says every field is valid
        busy: false,          // a payment is in flight
        pending: null,        // an in-flight sync() promise
        resultWaiter: null,   // resolves payFor() from the frame's 'result' event
        listeners: {}
    };

    function emit(name, payload) {
        (state.listeners[name] || []).forEach(function (fn) {
            try { fn(payload); } catch (e) { /* listener's problem */ }
        });
    }

    /* ── small DOM helpers ─────────────────────────────────────────────────── */
    function mountEl() { return state.container || d.querySelector('[data-synra-hs-mount]'); }
    function statusEl() {
        var m = mountEl(); if (!m) { return null; }
        var el = m.querySelector('.synra-pay-hs-status');
        if (!el) { el = d.createElement('p'); el.className = 'synra-pay-hs-status'; m.appendChild(el); }
        return el;
    }
    function fieldsEl() {
        var m = mountEl(); if (!m) { return null; }
        var el = m.querySelector('.synra-pay-hs-fields');
        if (!el) { el = d.createElement('div'); el.className = 'synra-pay-hs-fields'; m.insertBefore(el, m.firstChild); }
        return el;
    }
    function setStatus(msg, kind) {
        var el = statusEl(); if (!el) { return; }
        el.textContent = msg || '';
        el.className = 'synra-pay-hs-status' + (kind ? ' is-' + kind : '');
        el.style.display = msg ? '' : 'none';
    }
    function setError(msg) { skeleton(false); setStatus(msg, 'error'); emit('error', { message: msg }); }
    /** The placeholder shown while the session opens and the fields mount. */
    function skeleton(on) {
        var m = mountEl(); if (!m) { return; }
        var el = m.querySelector('.synra-pay-hs-skeleton');
        if (on && !el) {
            el = d.createElement('div'); el.className = 'synra-pay-hs-skeleton'; el.setAttribute('aria-hidden', 'true');
            el.innerHTML = '<span class="synra-pay-hs-sk synra-pay-hs-sk-label"></span><span class="synra-pay-hs-sk synra-pay-hs-sk-field"></span>'
                + '<span class="synra-pay-hs-sk-row"><span class="synra-pay-hs-sk synra-pay-hs-sk-half"></span><span class="synra-pay-hs-sk synra-pay-hs-sk-half"></span></span>'
                + '<span class="synra-pay-hs-sk synra-pay-hs-sk-label"></span><span class="synra-pay-hs-sk synra-pay-hs-sk-field"></span>';
            m.insertBefore(el, m.firstChild);
        }
        if (el) { el.style.display = on ? '' : 'none'; }
        var f = m.querySelector('.synra-pay-hs-fields');
        if (f) { f.style.display = on ? 'none' : ''; }
    }

    /* ── hosted-session.js ─────────────────────────────────────────────────────
       SynraPay's public script for merchant pages. Its card fields (sdk.js) are
       internal and refuse a page that loads them directly. */
    function loadSdk(url) {
        if (w.SynraHostedSession) { return Promise.resolve(w.SynraHostedSession); }
        if (state.sdkPromise) { return state.sdkPromise; }
        state.sdkPromise = new Promise(function (resolve, reject) {
            var s = d.createElement('script');
            s.src = url || cfg.sdkUrl;
            s.async = true;
            function failed() {
                state.sdkPromise = null;
                if (s.parentNode) { s.parentNode.removeChild(s); }
                reject(new Error(i18n.sdkFailed || 'Could not load the card form.'));
            }
            s.onload = function () { if (w.SynraHostedSession) { resolve(w.SynraHostedSession); } else { failed(); } };
            s.onerror = failed;
            d.head.appendChild(s);
        });
        return state.sdkPromise;
    }

    /* ── the store's endpoints ─────────────────────────────────────────────── */
    function formKey() {
        try { return $.mage.cookies.get('form_key') || ''; } catch (e) { return ''; }
    }
    function post(url, data) {
        var body = new FormData();
        body.append('form_key', formKey());
        Object.keys(data || {}).forEach(function (k) { if (data[k] != null) { body.append(k, String(data[k])); } });
        return fetch(url, { method: 'POST', credentials: 'same-origin', body: body, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
            .then(function (r) {
                return r.json().catch(function () {
                    return { ok: false, status: r.status, error: 'The store did not answer (HTTP ' + r.status + '). Check var/log/synra-pay.log.' };
                });
            });
    }

    /**
     * Open (or keep) a session for this customer and the current total.
     *   customer: { email, phone, phone_country_code?, country?, first_name?, last_name?, total? }
     * Resolves the session, or rejects with an Error the caller may show.
     */
    function sync(customer, opts) {
        opts = opts || {};
        if (state.busy) { return Promise.resolve(state.session); }
        customer = customer || state.customer || {};
        state.customer = customer;
        var key = JSON.stringify([customer.email, customer.phone, customer.phone_country_code, customer.country, customer.first_name, customer.last_name, customer.total]);

        if (!opts.fresh && state.session && state.fields && key === state.key && !expired() && mounted()) { return Promise.resolve(state.session); }
        if (state.pending && state.pending.key === key && !opts.fresh) { return state.pending.promise; }

        setStatus('', '');
        skeleton(true);
        var p = post(cfg.sessionUrl, {
            email: customer.email, phone: customer.phone, phone_country_code: customer.phone_country_code || '',
            country: customer.country || '', first_name: customer.first_name || '', last_name: customer.last_name || '',
            fresh: opts.fresh ? '1' : ''
        }).then(function (r) {
            if (!r || !r.ok || !r.clientToken) {
                throw new Error((r && r.error) || ('Could not start the card session.' + (r && r.status ? ' (HTTP ' + r.status + ')' : '')));
            }
            var sess = { clientToken: r.clientToken, orderId: r.orderId, merchantOrderId: r.merchantOrderId, amount: r.amount, currency: r.currency, expiresAt: r.expiresAt };
            state.key = key;
            // Same Direct API order and fields already up: keep what the shopper typed.
            if (!opts.fresh && state.session && state.fields && state.session.orderId === sess.orderId && !expired() && mounted()) {
                state.session.amount = sess.amount; state.session.currency = sess.currency;
                return state.session;
            }
            state.session = sess;
            return mount(sess);
        });
        p.catch(function () { /* reported by the caller */ });
        state.pending = { key: key, promise: p };
        p.then(function () { if (state.pending && state.pending.promise === p) { state.pending = null; } },
            function (e) { if (state.pending && state.pending.promise === p) { state.pending = null; } setError(e.message); });
        return p;
    }

    /** Is the frame still in the page? Knockout re-renders the payment box when the method list changes. */
    function mounted() {
        var m = mountEl();
        var host = m && m.querySelector('.synra-pay-hs-fields');
        return !!(host && host.querySelector('iframe'));
    }

    function expired() {
        if (!state.session || !state.session.expiresAt) { return false; }
        var t = Date.parse(state.session.expiresAt);
        return isFinite(t) && t - Date.now() < 15000;
    }

    /**
     * The bank's 3-D Secure check is stretched over the page by the fields.
     * While a payment runs, nothing of ours may hide or clip it (synra-pay.css).
     */
    function challenge(open) {
        d.documentElement.classList.toggle('synra-pay-challenge-open', open);
        emit('challenge', { open: open });
    }

    /** Mount SynraPay's card fields for the session into the checkout box. */
    function mount(sess) {
        return loadSdk(cfg.sdkUrl).then(function (HS) {
            var host = fieldsEl();
            if (!host) { throw new Error('No place to show the card form.'); }
            destroyFields();
            host.textContent = '';
            host.style.display = 'none';   // the skeleton stands in until the fields say ready
            // 3-D Secure runs over this page and nothing redirects: the store confirms
            // the ORDER; what the fields say about the outcome is only shown.
            state.fields = HS.mount({
                clientToken: sess.clientToken,
                container: host,
                onReady: function () { state.complete = true; skeleton(false); setStatus('', ''); emit('ready', sess); },
                onCompleted: function (r) { if (state.resultWaiter) { var fn = state.resultWaiter; state.resultWaiter = null; fn(r || {}); } },
                onError: function (e) {
                    e = e || {};
                    if (e.code === 'HOSTED_FIELDS_SESSION_EXPIRED') {
                        setStatus(i18n.expired || 'The card session expired. A new one is loading…', 'muted');
                        sync(state.customer, { fresh: false, reopen: true });
                        return;
                    }
                    // The fields show it themselves, or the payment in flight answers for it.
                    if (e.displayed || state.busy) { return; }
                    setError((e.message || 'The card fields reported a problem.') + (e.reference ? ' Reference: ' + e.reference : ''));
                }
            });
            return sess;
        });
    }

    function destroyFields() {
        if (state.fields) { try { state.fields.destroy(); } catch (e) { /* noop */ } }
        state.fields = null;
        state.complete = false;
    }

    /* ── pay + confirm ─────────────────────────────────────────────────────── */
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // abandon ('cancel' | 'declined'): the attempt ended without a payment. The
    // store then cancels the unpaid order, restores the cart and answers where
    // to send the shopper.
    function confirm(orderId, maxTries, frameOk, abandon) {
        var tries = maxTries || 60;
        function once() {
            return post(cfg.confirmUrl, { order_id: orderId, frame_ok: frameOk ? '1' : '', abandon: abandon || '' }).then(function (r) {
                if (r && r.status === 'paid' && r.redirect) { return { paid: true, redirect: r.redirect }; }
                if (r && r.status === 'failed') { return { paid: false, failed: true, message: r.error, redirect: r.redirect }; }
                if (r && r.status === 'error') { return { paid: false, failed: true, message: r.error }; }
                if (--tries <= 0) { return { paid: false, failed: false, message: i18n.declined || 'Your payment was not completed.' }; }
                return sleep(1500).then(once);
            });
        }
        return once();
    }

    /**
     * Magento placed the order (pending_payment) and answered its id: pay on
     * the mounted fields, then let the store confirm the order.
     */
    function payFor(orderId) {
        if (state.busy) { return; }
        if (!state.fields) { setError(i18n.notReady || 'The card form is not ready.'); emit('fail', { message: i18n.notReady }); return; }
        state.busy = true;
        emit('busy', { busy: true, message: i18n.processing || 'Processing your payment…' });
        setStatus(i18n.processing || 'Processing your payment…', 'muted');

        var f = state.fields;
        var host = fieldsEl();
        skeleton(false);
        if (host) { host.style.display = ''; }
        challenge(true);
        var viaEvent = new Promise(function (resolve) { state.resultWaiter = resolve; });
        var viaSubmit = f.pay();
        viaSubmit.catch(function () { /* reported through the race */ });
        Promise.race([viaSubmit, viaEvent]).then(function (r) {
            state.resultWaiter = null;
            challenge(false);
            r = r || {};
            // Approved, or not known yet: the ORDER's status decides.
            if (r.ok || r.status === 'pending') {
                setStatus(i18n.confirming || 'Confirming your payment…', 'muted');
                return confirm(orderId, 0, !!r.ok);
            }
            // Nothing was sent (a card detail to fix, or the fields were not ready):
            // the fields say what, and keep what the shopper typed. The Magento
            // order stays as placed; the next Place Order pays it (method renderer).
            if (r.code) {
                return { paid: false, inline: true, message: r.message || i18n.incomplete || 'Please check your card details.' };
            }
            // Declined or cancelled: the store reads the order once more, cancels
            // the unpaid Magento order, restores the cart and sends the shopper to
            // it with the reason. Magento emptied the cart when the order was
            // placed, so there is nothing to retry on this page.
            return confirm(orderId, 3, false, r.status === 'cancel' ? 'cancel' : 'declined').then(function (c) {
                return c.paid ? c : { paid: false, failed: true, message: r.message || c.message, redirect: c.redirect };
            });
        }).then(function (out) {
            state.busy = false;
            if (out.paid) { setStatus(i18n.confirming || 'Confirming…', 'muted'); w.location.assign(out.redirect); return; }
            var msg = out.message || (i18n.declined || 'Your payment was not completed. Please try again or use another card.');
            // The cart is back: go to it. The loader stays up until the page changes.
            if (out.redirect) { setStatus(msg, 'error'); w.location.assign(out.redirect); return; }
            emit('busy', { busy: false });
            setError(msg);
            emit('fail', { message: msg, retry: true, inline: !!out.inline, orderId: orderId });
            if (out.inline) { return; }
            // The fields now show their own "declined" screen; open a clean session for
            // the next try (a new Direct API order: the store forgets the old one).
            sync(state.customer, { fresh: true }).catch(function () { /* shown already */ });
        }).catch(function (e) {
            state.busy = false;
            challenge(false);
            emit('busy', { busy: false });
            var msg = (e && e.message) || 'The payment could not be sent.';
            setError(msg);
            emit('fail', { message: msg, retry: true });
        });
    }

    w.SynraHS = {
        cfg: cfg,
        sync: sync,
        payFor: payFor,
        setContainer: function (el) { state.container = el; },
        ready: function () { return !!state.fields && !!state.session && !expired(); },
        complete: function () { return state.complete; },
        busy: function () { return state.busy; },
        orderId: function () { return state.session ? state.session.orderId : ''; },
        session: function () { return state.session; },
        destroy: function () { destroyFields(); state.session = null; state.key = ''; },
        setStatus: setStatus,
        setError: setError,
        on: function (name, fn) { (state.listeners[name] = state.listeners[name] || []).push(fn); return this; },
        /** Dial code for a country code, from the store's table. */
        dialCode: function (cc) { return (cfg.dialCodes || {})[String(cc || '').toUpperCase()] || ''; }
    };
    return w.SynraHS;
});
