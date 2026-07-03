from celery import Celery
import odoorpc
import os
import logging


# Configuration
REDIS_URL = os.getenv('REDIS_URL', 'redis://redis:6379')
ODOO_URL = os.getenv('ODOO_URL', 'http://odoo:8069')
ODOO_DB = os.getenv('ODOO_DB', 'erp_db')
ODOO_USERNAME = os.getenv('ODOO_USERNAME', 'admin')
ODOO_PASSWORD = os.getenv('ODOO_PASSWORD', 'admin')

# Initialize Celery
app = Celery('erp_tasks', broker=REDIS_URL, backend=REDIS_URL)
app = Celery('tasks', broker='redis://redis:6379/0')
@app.task
def dummy_task():
    return "OK"

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@app.task
def send_order_confirmation(order_id):
    """Send order confirmation via WhatsApp and Telegram"""
    try:
        odoo = odoorpc.ODOO(ODOO_URL.replace('http://', ''), port=8069)
        odoo.login(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD)
        
        order = odoo.env['sale.order'].browse(order_id)
        
        # Send WhatsApp notification
        if order.partner_id.whatsapp_number and order.partner_id.whatsapp_order_confirmation:
            odoo.env['whatsapp.message'].create({
                'name': f'Order Confirmation - {order.name}',
                'message_type': 'order_update',
                'recipient_number': order.partner_id.whatsapp_number,
                'partner_id': order.partner_id.id,
                'sale_order_id': order.id,
            }).send_message()
        
        logger.info(f"Order confirmation sent for {order.name}")
        
    except Exception as e:
        logger.error(f"Failed to send order confirmation: {e}")

@app.task
def send_invoice_notification(invoice_id):
    """Send invoice notification"""
    try:
        odoo = odoorpc.ODOO(ODOO_URL.replace('http://', ''), port=8069)
        odoo.login(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD)
        
        invoice = odoo.env['account.move'].browse(invoice_id)
        
        if invoice.partner_id.whatsapp_number and invoice.partner_id.whatsapp_invoice_notification:
            odoo.env['whatsapp.message'].create({
                'name': f'Invoice - {invoice.name}',
                'message_type': 'invoice',
                'recipient_number': invoice.partner_id.whatsapp_number,
                'partner_id': invoice.partner_id.id,
                'invoice_id': invoice.id,
            }).send_message()
        
        logger.info(f"Invoice notification sent for {invoice.name}")
        
    except Exception as e:
        logger.error(f"Failed to send invoice notification: {e}")

@app.task
def send_payment_reminder(invoice_id):
    """Send payment reminder"""
    try:
        odoo = odoorpc.ODOO(ODOO_URL.replace('http://', ''), port=8069)
        odoo.login(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD)
        
        invoice = odoo.env['account.move'].browse(invoice_id)
        
        if invoice.partner_id.whatsapp_number and invoice.partner_id.whatsapp_payment_reminder:
            odoo.env['whatsapp.message'].create({
                'name': f'Payment Reminder - {invoice.name}',
                'message_type': 'payment_reminder',
                'recipient_number': invoice.partner_id.whatsapp_number,
                'partner_id': invoice.partner_id.id,
                'invoice_id': invoice.id,
            }).send_message()
        
        logger.info(f"Payment reminder sent for {invoice.name}")
        
    except Exception as e:
        logger.error(f"Failed to send payment reminder: {e}")

@app.task
def process_message_queue():
    """Process pending messages in queue"""
    try:
        odoo = odoorpc.ODOO(ODOO_URL.replace('http://', ''), port=8069)
        odoo.login(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD)
        
        # Find all queued messages
        messages = odoo.env['whatsapp.message'].search([('state', '=', 'queued')])
        
        for message in messages:
            message.send_message()
            
        logger.info(f"Processed {len(messages)} queued messages")
        
    except Exception as e:
        logger.error(f"Failed to process message queue: {e}")

# Schedule periodic tasks
app.conf.beat_schedule = {
    'process-queue-every-minute': {
        'task': 'tasks.process_message_queue',
        'schedule': 60.0,  # Every minute
    },
    'send-payment-reminders-daily': {
        'task': 'tasks.send_payment_reminders',
        'schedule': 86400.0,  # Every day
    },
}

@app.task
def send_payment_reminders():
    """Send payment reminders for overdue invoices"""
    try:
        odoo = odoorpc.ODOO(ODOO_URL.replace('http://', ''), port=8069)
        odoo.login(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD)
        
        # Find overdue invoices
        today = fields.Date.today()
        invoices = odoo.env['account.move'].search([
            ('move_type', '=', 'out_invoice'),
            ('state', '=', 'posted'),
            ('payment_state', 'in', ['not_paid', 'partial']),
            ('invoice_date_due', '<', today),
        ])
        
        for invoice in invoices:
            if invoice.partner_id.whatsapp_number and invoice.partner_id.whatsapp_payment_reminder:
                send_payment_reminder.delay(invoice.id)
        
        logger.info(f"Payment reminders sent for {len(invoices)} invoices")
        
    except Exception as e:
        logger.error(f"Failed to send payment reminders: {e}")
