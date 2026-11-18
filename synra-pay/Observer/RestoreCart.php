<?php
declare(strict_types=1);

namespace Synra\Pay\Observer;

use Magento\Checkout\Model\Session as CheckoutSession;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Sales\Model\Order;
use Synra\Pay\Model\Api\Client;
use Synra\Pay\Model\CartRestorer;
use Synra\Pay\Model\Config;
use Synra\Pay\Model\Log;
use Synra\Pay\Model\OrderSettler;

/**
 * The shopper is back on the cart or the checkout with an order of ours still
 * unpaid: they reloaded the page or left during the payment. The cart went
 * empty when that order was placed, so it is given back here, unless SynraPay
 * says the order is paid or still being confirmed.
 *
 * One status read decides (6 s at most, and only while such an order exists).
 * A read that fails changes nothing: the cron re-check settles the order.
 */
class RestoreCart implements ObserverInterface
{
    /** @var CheckoutSession */
    private $checkoutSession;
    /** @var Client */
    private $client;
    /** @var OrderSettler */
    private $settler;
    /** @var CartRestorer */
    private $restorer;
    /** @var Log */
    private $log;

    public function __construct(
        CheckoutSession $checkoutSession,
        Client $client,
        OrderSettler $settler,
        CartRestorer $restorer,
        Log $log
    ) {
        $this->checkoutSession = $checkoutSession;
        $this->client          = $client;
        $this->settler         = $settler;
        $this->restorer        = $restorer;
        $this->log             = $log;
    }

    public function execute(Observer $observer)
    {
        try {
            // The cart page renders session messages straight away. The checkout
            // page may not, and a message left queued would appear later on
            // another page (the success page of the next, paid, order).
            $request = $observer->getEvent()->getData('request');
            $onCart  = $request && method_exists($request, 'getFullActionName') && $request->getFullActionName() === 'checkout_cart_index';
            $this->restore($onCart);
        } catch (\Throwable $e) {
            // Never in the way of the cart or the checkout page.
            $this->log->warning('cart restore skipped: ' . $e->getMessage());
        }
    }

    private function restore(bool $withNotice): void
    {
        $order = $this->checkoutSession->getLastRealOrder();
        if (!$order || !$order->getId() || !$order->getPayment()) {
            return;
        }
        $payment = $order->getPayment();
        if ($payment->getMethod() !== Config::CODE || $order->getState() !== Order::STATE_PENDING_PAYMENT) {
            return;
        }
        // Approved in the card frame and waiting for SynraPay's confirmation: not lost.
        if ($payment->getAdditionalInformation(OrderSettler::META_AWAITING)) {
            return;
        }
        // The shopper already has a new cart: leave it alone.
        $quote = $this->checkoutSession->getQuote();
        if ($quote && (int) $quote->getItemsCount() > 0) {
            return;
        }
        $direct = (string) $payment->getAdditionalInformation(OrderSettler::META_DIRECT_ORDER);
        if ($direct === '') {
            return;
        }
        list($ok, $data) = $this->client->status($direct, 6);
        if (!$ok || !is_array($data)) {
            return;
        }
        if (isset($data['confirmation']) && $data['confirmation'] === 'awaiting_mastercard') {
            return;
        }
        if ($this->settler->applyStatus($order, $data, 'return') === 'paid') {
            return;
        }
        $this->restorer->giveBack(
            $order,
            'not completed, the shopper left the payment',
            'return',
            $withNotice ? (string) __('Your payment was not completed and you have not been charged. Your cart has been restored.') : ''
        );
    }
}
