const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { MongoClient } = require('mongodb');

const app = express();

app.use(cors());
app.use(express.json());

// ===============================
// CONFIG
// ===============================
const clientMP = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

const paymentApi = new Payment(clientMP);

const mongoUri = process.env.MONGODB_URI;
const mongoClient = new MongoClient(mongoUri);

let db;
let pedidosCollection;

// ===============================
// CONEXÃO COM MONGODB
// ===============================
async function conectarMongo() {
    try {
        await mongoClient.connect();
        db = mongoClient.db('tonclay_sorteios');
        pedidosCollection = db.collection('pedidos');
        console.log('✅ MongoDB conectado com sucesso');
    } catch (error) {
        console.error('❌ Erro ao conectar no MongoDB:', error);
    }
}

// ===============================
// GERA NÚMERO ÚNICO
// ===============================
async function gerarNumeroUnico() {
    const pedidosAprovados = await pedidosCollection.find({
        numero: { $ne: null }
    }).toArray();

    const usados = pedidosAprovados
        .map(p => p.numero)
        .filter(n => n !== null && n !== undefined);

    if (usados.length >= 100) {
        return null;
    }

    let numero;
    do {
        numero = Math.floor(Math.random() * 100);
    } while (usados.includes(numero));

    return numero;
}

// ===============================
// ROTA TESTE
// ===============================
app.get('/', (req, res) => {
    res.send('Servidor rodando 🔥');
});

// ===============================
// CRIAR PAGAMENTO PIX
// ===============================
app.post('/criar-pagamento', async (req, res) => {
    try {
        const { nome, email, whatsapp } = req.body;

        if (!nome) {
            return res.status(400).json({ erro: 'Nome é obrigatório' });
        }

        if (!email) {
            return res.status(400).json({ erro: 'Email é obrigatório' });
        }

        const pagamento = await paymentApi.create({
            body: {
                transaction_amount: 10,
                description: 'Participação sorteio TonClay',
                payment_method_id: 'pix',
                payer: {
                    email: email,
                    first_name: nome
                },
                notification_url: 'https://tonclay-backend.onrender.com/webhook'
            }
        });

        const transactionData = pagamento?.point_of_interaction?.transaction_data || {};

        await pedidosCollection.insertOne({
            paymentId: String(pagamento.id),
            nome,
            email,
            whatsapp: whatsapp || '',
            status: pagamento.status || 'pending',
            numero: null,
            valor: 10,
            quantidade: 1,
            criadoEm: new Date()
        });

        return res.json({
            id: pagamento.id,
            status: pagamento.status,
            qr_code: transactionData.qr_code || '',
            qr_code_base64: transactionData.qr_code_base64 || '',
            ticket_url: transactionData.ticket_url || ''
        });
    } catch (error) {
        console.error('❌ Erro ao criar pagamento:', error);
        return res.status(500).json({
            erro: 'Erro ao criar pagamento',
            detalhe: error?.message || error
        });
    }
});

// ===============================
// WEBHOOK
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        console.log('🔔 Webhook recebido:', JSON.stringify(req.body));

        const tipo = req.body.type || req.body.topic;
        const paymentId =
            req.body?.data?.id ||
            req.body?.resource?.split('/').pop();

        if (!paymentId || (tipo !== 'payment' && tipo !== 'payments')) {
            return res.sendStatus(200);
        }

        const pagamentoMercadoPago = await paymentApi.get({ id: paymentId });
        const status = pagamentoMercadoPago.status;

        const pedido = await pedidosCollection.findOne({ paymentId: String(paymentId) });

        if (!pedido) {
            return res.sendStatus(200);
        }

        if (status === 'approved' && pedido.numero === null) {
            const numero = await gerarNumeroUnico();

            await pedidosCollection.updateOne(
                { paymentId: String(paymentId) },
                {
                    $set: {
                        status,
                        numero,
                        aprovadoEm: new Date()
                    }
                }
            );

            console.log(`✅ Pagamento aprovado. Número gerado para ${paymentId}: ${numero}`);
        } else {
            await pedidosCollection.updateOne(
                { paymentId: String(paymentId) },
                {
                    $set: {
                        status
                    }
                }
            );
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        return res.sendStatus(500);
    }
});

// ===============================
// CONSULTAR STATUS
// ===============================
app.get('/status-pagamento/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const pedido = await pedidosCollection.findOne({ paymentId: String(id) });

        if (!pedido) {
            return res.status(404).json({ erro: 'Pagamento não encontrado' });
        }

        return res.json({
            id: pedido.paymentId,
            status: pedido.status,
            numero: pedido.numero,
            nome: pedido.nome
        });
    } catch (error) {
        console.error('❌ Erro ao consultar status:', error);
        return res.status(500).json({ erro: 'Erro ao consultar status' });
    }
});

const PORT = process.env.PORT || 3000;

conectarMongo().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor rodando na porta ${PORT}`);
    });
});