<?php
declare(strict_types=1);

namespace Synra\Pay\Controller\Hs;

use Magento\Checkout\Model\Session as CheckoutSession;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\Controller\Result\RedirectFactory;
use Magento\Framework\View\Result\PageFactory;
use Magento\Sales\Model\Order;
use Synra\Pay\Model\Api\Client;
use Synra\Pay\Model\CartRestorer;
use Synra\Pay\Model\Config;
use Synra\Pay\Model\Log;
use Synra\Pay\Model\OrderSettler;

/**
 * GET /synra/hs/failed?reason=cancel|declined — where the checkout sends the
 * shopper when a payment ends without money moving: the bank check was
 * cancelled, or the card was declined.
 *
 * Arriving here is what settles the unpaid Magento order. SynraPay is asked
 * once more:
 *
 *   paid                 → the success page (the page was wrong; the order is paid)
 *   still confirming     → "we are confirming your payment", nothing is canceled
 *   not paid             → the order is canceled and the cart given back; the
 *                          page says so and offers "Try again" (the cart)
 *   no answer            → nothing is canceled; the page still says the payment
 *                          was not completed, and the cart comes back when the
 *                          shopper opens it (Observer\RestoreCart)
 *
 * The page carries its own text. Nothing is queued as a session message, so
 * nothing can show up later on another page.
 */
class Failed implements HttpGetActionInterface
{
    /** @var HttpRequest */
    private $request;
    /** @var PageFactory */
    private $pageFactory;
    /** @var RedirectFactory */
    private $redirectFactory;
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
        HttpRequest $request,
        PageFactory $pageFactory,
        RedirectFactory $redirectFactory,
        CheckoutSession $checkoutSession,
        Client $client,
        OrderSettler $settler,
        CartRestorer $restorer,
        Log $log
    ) {
        $this->request         = $request;
        $this->pageFactory     = $pageFactory;
        $this->redirectFactory = $redirectFactory;
        $this->checkoutSession = $checkoutSession;
        $this->client          = $client;
        $this->settler         = $settler;
        $this->restorer        = $restorer;
        $this->log             = $log;
    }

    public function execute()
    {
        $cancelled = (string) $this->request->getParam('reason', '') === 'cancel';
        $view      = $cancelled ? 'cancelled' : 'declined';
        $number    = '';

        try {
            $order = $this->checkoutSession->getLastRealOrder();
            if ($order && $order->getId() && $order->getPayment() && $order->getPayment()->getMethod() === Config::CODE) {
                $number = (string) $order->getIncrementId();
                $state  = $this->settle($order, $cancelled);
                if ($state === 'paid') {
                    return $this->redirectFactory->create()->setPath('checkout/onepage/success', ['_secure' => true]);
                }
                if ($state === 'confirming') {
                    $view = 'confirming';
                }
            }
        } catch (\Throwable $e) {
            $this->log->warning('failed page: ' . $e->getMessage());
        }

        $page = $this->pageFactory->create();
        $titles = [
            'cancelled'  => __('Payment cancelled'),
            'declined'   => __('Payment not completed'),
            'confirming' => __('We are confirming your payment'),
        ];
        $page->getConfig()->getTitle()->set($titles[$view]);
        $block = $page->getLayout()->getBlock('synra.pay.failed');
        if ($block) {
            $block->setData('view', $view);
            $block->setData('order_number', $number);
        }
        return $page;
    }

    /** paid | confirming | lost. Cancels the unpaid order and restores the cart when SynraPay shows no payment. */
    private function settle(Order $order, bool $cancelled): string
    {
        if ($this->settler->isPaid($order)) {
            return 'paid';
        }
        if ($order->getState() !== Order::STATE_PENDING_PAYMENT) {
            return 'lost';   // already canceled: the cart was given back then
        }
        if ($order->getPayment()->getAdditionalInformation(OrderSettler::META_AWAITING)) {
            return 'confirming';
        }
        $direct = (string) $order->getPayment()->getAdditionalInformation(OrderSettler::META_DIRECT_ORDER);
        if ($direct === '') {
            return 'lost';
        }
        list($ok, $data) = $this->client->status($direct, 10);
        if (!$ok || !is_array($data)) {
            return 'lost';   // no answer: cancel nothing here
        }
        if (isset($data['confirmation']) && $data['confirmation'] === 'awaiting_mastercard') {
            return 'confirming';
        }
        if ($this->settler->applyStatus($order, $data, 'failed-page') === 'paid') {
            return 'paid';
        }
        $this->restorer->giveBack($order, $cancelled ? 'cancelled by the shopper' : 'declined', 'failed-page');
        return 'lost';
    }
}
