const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

app.use(express.json());
app.use(cors());

// 🔐 SUA ACCESS TOKEN DO MERCADO PAGO
const client = new MercadoPagoConfig({
    accessToken: 'TEST-8440426272093769-040203-bc1cd28b7791003645b4ac9faac4451c-1711765230'
});

// 🔢 controle simples de números (depois vamos colocar banco)
let numerosUsados = [];

// 🚀 CRIAR PAGAMENTO PIX
app.post('/criar-pagamento', async (req, res) => {
    const { nome, email } = req.body;

    try {
        const payment = new Payment(client);

        const response = await payment.create({
            body: {
                transaction_amount: 10,
                description: 'Participação sorteio TonClay',
                payment_method_id: 'pix',
                payer: {
                    email: email || 'artdecorconstrutora@gmail.com'
                }
            }
        });

        res.json({
            id: response.id,
            qr_code: response.point_of_interaction.transaction_data.qr_code,
            qr_code_base64: response.point_of_interaction.transaction_data.qr_code_base64
        });

    } catch (error) {
        console.log(error);
        res.status(500).send('Erro ao criar pagamento');
    }
});

// 🔥 WEBHOOK (CONFIRMA PAGAMENTO)
app.post('/webhook', async (req, res) => {
    console.log('🔔 Webhook recebido:', req.body);

    // 👉 Aqui depois vamos validar pagamento e gerar número

    res.sendStatus(200);
});

// 🧪 ROTA TESTE
app.get('/', (req, res) => {
    res.send('Servidor rodando 🔥');
});

// 🚀 START
app.listen(3000, () => {
    console.log('🚀 Servidor rodando em http://localhost:3000');
});