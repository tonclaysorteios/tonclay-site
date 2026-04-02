const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

app.use(cors());
app.use(express.json());

const clientMP = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

const paymentApi = new Payment(clientMP);

// memória temporária
const pedidos = {};

function gerarNumerosUnicos(quantidade = 1) {
    const usados = Object.values(pedidos)
        .flatMap(p => Array.isArray(p.numeros) ? p.numeros : []);

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

app.get('/health', (req, res) => {
    res.json({ ok: true, banco: 'desativado_temporariamente' });
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

        pedidos[String(pagamento.id)] = {
            paymentId: String(pagamento.id),
            nome,
            email,
            whatsapp: whatsapp || '',
            status: pagamento.status || 'pending',
            numeros: [],
            valor: valorTotal,
            quantidade: qtd,
            criadoEm: new Date()
        };

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

        const pagamentoMercadoPago = await paymentApi.get({ id: paymentId });
        const status = pagamentoMercadoPago.status;

        if (!pedidos[String(paymentId)]) {
            pedidos[String(paymentId)] = {
                paymentId: String(paymentId),
                nome: '',
                email: '',
                whatsapp: '',
                status,
                numeros: [],
                quantidade: 1,
                valor: 10,
                criadoEm: new Date()
            };
        }

        const pedido = pedidos[String(paymentId)];
        pedido.status = status;

        if (status === 'approved' && (!pedido.numeros || pedido.numeros.length === 0)) {
            const numeros = gerarNumerosUnicos(pedido.quantidade || 1);
            pedido.numeros = numeros || [];
            pedido.aprovadoEm = new Date();

            console.log(`✅ Pagamento aprovado. Números gerados para ${paymentId}: ${pedido.numeros.join(', ')}`);
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        return res.sendStatus(500);
    }
});

app.get('/status-pagamento/:id', (req, res) => {
    try {
        const { id } = req.params;
        const pedido = pedidos[String(id)];

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});