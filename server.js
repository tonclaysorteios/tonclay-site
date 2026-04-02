const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { MongoClient } = require('mongodb');

const app = express();

app.use(cors());
app.use(express.json());

const clientMP = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

const paymentApi = new Payment(clientMP);

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
    throw new Error('MONGODB_URI não foi definida no Render');
}

const mongoClient = new MongoClient(mongoUri);

let db;
let pedidosCollection;

async function conectarMongo() {
    try {
        await mongoClient.connect();
        db = mongoClient.db('tonclay_sorteios');
        pedidosCollection = db.collection('pedidos');
        console.log('✅ MongoDB conectado com sucesso');
    } catch (error) {
        console.error('❌ Erro ao conectar no MongoDB:', error);
        throw error;
    }
}

async function gerarNumerosUnicos(quantidade = 1) {
    if (!pedidosCollection) return [];

    const pedidosAprovados = await pedidosCollection.find({
        numeros: { $exists: true, $ne: [] }
    }).toArray();

    const usados = pedidosAprovados.flatMap(p =>
        Array.isArray(p.numeros) ? p.numeros : []
    );

    if (usados.length + quantidade > 100) {
        return null;
    }

    const novosNumeros = [];

    while (novosNumeros.length < quantidade) {
        const numero = Math.floor(Math.random() * 100);

        if (!usados.includes(numero) && !novosNumeros.includes(numero)) {
            novosNumeros.push(numero);
        }
    }

    return novosNumeros;
}

app.get('/', (req, res) => {
    res.send('Servidor rodando 🔥');
});

app.get('/health', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                ok: false,
                mongo: 'disconnected',
                erro: 'db não inicializado'
            });
        }

        await db.command({ ping: 1 });

        return res.json({
            ok: true,
            mongo: 'connected'
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            mongo: 'disconnected',
            erro: error.message
        });
    }
});

app.post('/criar-pagamento', async (req, res) => {
    try {
        const { nome, email, whatsapp, quantidade } = req.body;

        if (!nome) {
            return res.status(400).json({ erro: 'Nome é obrigatório' });
        }

        if (!email) {
            return res.status(400).json({ erro: 'Email é obrigatório' });
        }

        const qtd = Number(quantidade) || 1;
        const valorUnitario = 10;
        const valorTotal = qtd * valorUnitario;

        const pagamento = await paymentApi.create({
            body: {
                transaction_amount: valorTotal,
                description: `Participação sorteio TonClay (${qtd} número${qtd > 1 ? 's' : ''})`,
                payment_method_id: 'pix',
                payer: {
                    email,
                    first_name: nome
                },
                notification_url: 'https://tonclay-backend.onrender.com/webhook'
            }
        });

        const transactionData = pagamento?.point_of_interaction?.transaction_data || {};

        console.log('🧾 Pagamento criado com sucesso:', pagamento.id);

        if (pedidosCollection) {
            try {
                await pedidosCollection.updateOne(
                    { paymentId: String(pagamento.id) },
                    {
                        $set: {
                            paymentId: String(pagamento.id),
                            nome,
                            email,
                            whatsapp: whatsapp || '',
                            status: pagamento.status || 'pending',
                            numeros: [],
                            valor: valorTotal,
                            quantidade: qtd,
                            criadoEm: new Date()
                        }
                    },
                    { upsert: true }
                );

                console.log(`✅ Pedido salvo no Mongo para paymentId ${pagamento.id}`);
            } catch (mongoError) {
                console.error('⚠️ Pagamento criado, mas falhou ao salvar no Mongo:', mongoError);
            }
        } else {
            console.error('⚠️ Mongo ainda não conectado. Pagamento criado sem persistência.');
        }

        return res.json({
            id: pagamento.id,
            status: pagamento.status,
            qr_code: transactionData.qr_code || '',
            qr_code_base64: transactionData.qr_code_base64 || '',
            ticket_url: transactionData.ticket_url || '',
            valor: valorTotal,
            quantidade: qtd
        });
    } catch (error) {
        console.error('❌ Erro ao criar pagamento:', error);
        return res.status(500).json({
            erro: 'Erro ao criar pagamento',
            detalhe: error.message || 'erro interno'
        });
    }
});

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

        if (!pedidosCollection) {
            console.error('⚠️ Webhook recebido, mas Mongo não está conectado.');
            return res.sendStatus(200);
        }

        const pagamentoMercadoPago = await paymentApi.get({ id: paymentId });
        const status = pagamentoMercadoPago.status;

        let pedido = await pedidosCollection.findOne({
            paymentId: String(paymentId)
        });

        if (!pedido) {
            await pedidosCollection.updateOne(
                { paymentId: String(paymentId) },
                {
                    $set: {
                        paymentId: String(paymentId),
                        status,
                        numeros: [],
                        quantidade: 1,
                        criadoEm: new Date()
                    }
                },
                { upsert: true }
            );

            pedido = await pedidosCollection.findOne({
                paymentId: String(paymentId)
            });
        }

        if (status === 'approved' && (!pedido.numeros || pedido.numeros.length === 0)) {
            const qtd = pedido.quantidade || 1;
            const numeros = await gerarNumerosUnicos(qtd);

            await pedidosCollection.updateOne(
                { paymentId: String(paymentId) },
                {
                    $set: {
                        status,
                        numeros,
                        aprovadoEm: new Date()
                    }
                }
            );

            console.log(`✅ Pagamento aprovado. Números gerados para ${paymentId}: ${numeros.join(', ')}`);
        } else {
            await pedidosCollection.updateOne(
                { paymentId: String(paymentId) },
                {
                    $set: { status }
                }
            );
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        return res.sendStatus(500);
    }
});

app.get('/status-pagamento/:id', async (req, res) => {
    try {
        if (!pedidosCollection) {
            return res.status(503).json({ erro: 'Mongo não conectado' });
        }

        const { id } = req.params;

        const pedido = await pedidosCollection.findOne({
            paymentId: String(id)
        });

        if (!pedido) {
            return res.status(404).json({ erro: 'Pagamento não encontrado' });
        }

        return res.json({
            id: pedido.paymentId,
            status: pedido.status,
            numeros: pedido.numeros || [],
            nome: pedido.nome,
            quantidade: pedido.quantidade || 1,
            valor: pedido.valor || 10
        });
    } catch (error) {
        console.error('❌ Erro ao consultar status:', error);
        return res.status(500).json({ erro: 'Erro ao consultar status' });
    }
});

const PORT = process.env.PORT || 3000;

(async () => {
    try {
        await conectarMongo();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Servidor rodando na porta ${PORT}`);
        });
    } catch (error) {
        console.error('❌ Falha ao iniciar servidor:', error);
        process.exit(1);
    }
})();