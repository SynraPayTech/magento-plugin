<?php
declare(strict_types=1);

namespace Synra\Pay\Model;

use Magento\Checkout\Model\Session as CheckoutSession;
use Magento\Framework\Message\ManagerInterface as MessageManager;
use Magento\Sales\Model\Order;

/**
 * Gives the shopper their cart back when a payment ends without money moving.
 *
 * Magento places the order before the card is charged, and placing it empties
 * the cart. A cancelled bank check, a declined card or a checkout the shopper
 * walked away from must not cost them the cart: the unpaid order is canceled,
 * its quote becomes the active cart again, the card session is forgotten (the
 * next one opens a new SynraPay order) and the next page says what happened.
 * Only a paid order keeps the cart empty.
 */
class CartRestorer
{
    /** @var CheckoutSession */
    private $checkoutSession;
    /** @var OrderSettler */
    private $settler;
    /** @var HostedSession */
    private $hostedSession;
    /** @var MessageManager */
    private $messageManager;
    /** @var Log */
    private $log;

    public function __construct(
        CheckoutSession $checkoutSession,
        OrderSettler $settler,
        HostedSession $hostedSession,
        MessageManager $messageManager,
        Log $log
    ) {
        $this->checkoutSession = $checkoutSession;
        $this->settler         = $settler;
        $this->hostedSession   = $hostedSession;
        $this->messageManager  = $messageManager;
        $this->log             = $log;
    }

    /**
     * Cancel the unpaid order (a no-op when it is already canceled, never for a
     * paid one) and put its quote back as the cart. `$notice` is shown on the
     * next page; pass '' for none. Returns false when the order is paid.
     */
    public function giveBack(Order $order, string $reason, string $source, string $notice = ''): bool
    {
        if ($this->settler->isPaid($order)) {
            return false;
        }
        $this->settler->markFailed($order, $reason, $source);
        $this->hostedSession->clear();
        $restored = $this->checkoutSession->restoreQuote();
        $this->log->info('cart ' . ($restored ? 'restored' : 'not restored') . ' for order #' . $order->getIncrementId() . ' (' . $source . ')');
        if ($notice !== '') {
            $this->messageManager->addErrorMessage($notice);
        }
        return true;
    }
}
