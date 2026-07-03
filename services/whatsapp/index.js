const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const Redis = require('redis');
const QRCode = require('qrcode-terminal');
const express = require('express');
const app = express();
const port = 3000;
app.get('/health', (req, res) => res.json({status: 'ok'}));
app.listen(port, () => console.log(`WhatsApp service running on port ${port}`));

// Configuration
const ODOO_URL = process.env.ODOO_URL || 'http://odoo:8069';
const ODOO_DB = process.env.ODOO_DB || 'erp_db';
const ODOO_USERNAME = process.env.ODOO_USERNAME || 'admin';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD || 'admin';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

// Initialize Express
const app = express();
app.use(express.json());

// Redis client
const redisClient = Redis.createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Error:', err));
redisClient.connect();

// Odoo API client
class OdooClient {
    constructor() {
        this.baseUrl = ODOO_URL;
        this.db = ODOO_DB;
        this.username = ODOO_USERNAME;
        this.password = ODOO_PASSWORD;
        this.sessionId = null;
    }

    async authenticate() {
        try {
            const response = await axios.post(`${this.baseUrl}/web/session/authenticate`, {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    db: this.db,
                    login: this.username,
                    password: this.password
                }
            });
            
            this.sessionId = response.data.result.session_id;
            return this.sessionId;
        } catch (error) {
            console.error('Odoo authentication failed:', error);
            throw error;
        }
    }

    async call(model, method, args = [], kwargs = {}) {
        if (!this.sessionId) {
            await this.authenticate();
        }

        try {
            const response = await axios.post(`${this.baseUrl}/web/dataset/call_kw`, {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: model,
                    method: method,
                    args: args,
                    kwargs: kwargs
                }
            }, {
                headers: {
                    'Cookie': `session_id=${this.sessionId}`
                }
            });

            return response.data.result;
        } catch (error) {
            console.error('Odoo API call failed:', error);
            throw error;
        }
    }

    async updateWhatsAppMessage(messageId, state, responseData = null) {
        return await this.call('whatsapp.message', 'write', [
            [messageId],
            {
                state: state,
                response_data: JSON.stringify(responseData)
            }
        ]);
    }
}

// WhatsApp Service
class WhatsAppService {
    constructor() {
        this.sock = null;
        this.odooClient = new OdooClient();
    }

    async connect() {
        const { state, saveCreds } = await useMultiFileAuthState('sessions');
        
        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: false
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                QRCode.generate(qr, { small: true });
                console.log('Scan this QR code with WhatsApp');
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed, reconnecting:', shouldReconnect);
                if (shouldReconnect) {
                    this.connect();
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connected successfully');
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        // Handle incoming messages
        this.sock.ev.on('messages.upsert', async (m) => {
            await this.handleIncomingMessage(m);
        });
    }

    async handleIncomingMessage(m) {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (msg.key.fromMe) continue;

                const from = msg.key.remoteJid;
                const messageContent = this.extractMessageContent(msg);
                
                if (messageContent) {
                    // Store message in Odoo
                    await this.odooClient.call('whatsapp.message', 'create', [{
                        name: `Message from ${from}`,
                        message_type: 'text',
                        recipient_number: from,
                        message_body: messageContent,
                        state: 'received'
                    }]);

                    // Auto-reply
                    await this.sendAutoReply(from);
                }
            }
        }
    }

    extractMessageContent(msg) {
        if (msg.message?.conversation) {
            return msg.message.conversation;
        }
        if (msg.message?.extendedTextMessage?.text) {
            return msg.message.extendedTextMessage.text;
        }
        if (msg.message?.imageMessage?.caption) {
            return msg.message.imageMessage.caption;
        }
        return null;
    }

    async sendAutoReply(to) {
        const reply = `Thank you for your message! Our team will respond shortly.\n\nFor immediate assistance:\n- Check orders: /order_status [order number]\n- Support: support@yourcompany.com\n- Call: +62xxx`;
        await this.sendTextMessage(to, reply);
    }

    async sendTextMessage(to, text) {
        try {
            await this.sock.sendMessage(to, { text });
        } catch (error) {
            console.error('Failed to send message:', error);
        }
    }

    async processQueue() {
        // Process message queue from Redis
        setInterval(async () => {
            try {
                const message = await redisClient.lPop('whatsapp:queue');
                if (message) {
                    const data = JSON.parse(message);
                    await this.sendTextMessage(data.recipient, data.content);
                    
                    // Update Odoo message status
                    await this.odooClient.updateWhatsAppMessage(
                        data.message_id, 
                        'sent'
                    );
                }
            } catch (error) {
                console.error('Queue processing error:', error);
            }
        }, 1000);
    }
}

// Start services
const whatsappService = new WhatsAppService();

app.listen(3000, async () => {
    console.log('WhatsApp service listening on port 3000');
    
    await whatsappService.odooClient.authenticate();
    await whatsappService.connect();
    await whatsappService.processQueue();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: whatsappService.sock?.user != null });
});
