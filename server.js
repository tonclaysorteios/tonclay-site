const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

app.use(cors());
app.use(express.json());

// Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

const paymentApi = new Payment(client);

// "Banco" temporário em memória para testes
// depois a gente troca por banco real
const pagamentos = {};

// Gera número único de 0 a 99
function gerarNumeroUnico() {
    const usados = Object.values(pagamentos)
        .filter(p => p.numero !== null && p.numero !== undefined)
        .map(p => p.numero);

    if (usados.length >= 100) {
        return null;
    }

    let numero;
    do {
        numero = Math.floor(Math.random() * 100);
    } while (usados.includes(numero));

    return numero;
}

// Rota teste
app.get('/', (req, res) => {
    res.send('Servidor rodando 🔥');
});

// Criar pagamento Pix
app.post('/criar-pagamento', async (req, res) => {
    try {
        const { nome, email, whatsapp } = req.body;

        if (!nome) {
            return res.status(400).json({ erro: 'Nome é obrigatório' });
        }

        const pagamento = await paymentApi.create({
            body: {
                transaction_amount: 10,
                description: 'Participação sorteio TonClay',
                payment_method_id: 'pix',
                payer: {
                    email: email || 'teste@email.com',
                    first_name: nome
                },
                notification_url: 'https://tonclay-backend.onrender.com/webhook'
            }
        });

        pagamentos[pagamento.id] = {
            id: pagamento.id,
            nome: nome,
            email: email || 'teste@email.com',
            whatsapp: whatsapp || '',
            status: pagamento.status || 'pending',
            numero: null,
            criadoEm: new Date().toISOString()
        };

        return res.json({
            id: pagamento.id,
            status: pagamento.status,
            qr_code: pagamento.point_of_interaction.transaction_data.qr_code,
            qr_code_base64: pagamento.point_of_interaction.transaction_data.qr_code_base64
        });
    } catch (error) {
        console.error('Erro ao criar pagamento:', error);
        return res.status(500).json({
            erro: 'Erro ao criar pagamento',
            detalhe: error?.message || error
        });
    }
});

// Webhook do Mercado Pago
app.post('/webhook', async (req, res) => {
    try {
        console.log('🔔 Webhook recebido:', JSON.stringify(req.body));

        // Mercado Pago pode enviar topic/type e data.id/resource
        const tipo = req.body.type || req.body.topic;
        const paymentId =
            req.body?.data?.id ||
            req.body?.resource?.split('/').pop();

        if (!paymentId || (tipo !== 'payment' && tipo !== 'payments')) {
            return res.sendStatus(200);
        }

        const pagamentoMercadoPago = await paymentApi.get({ id: paymentId });
        const status = pagamentoMercadoPago.status;

        if (!pagamentos[paymentId]) {
            pagamentos[paymentId] = {
                id: paymentId,
                nome: '',
                email: '',
                whatsapp: '',
                status: status,
                numero: null,
                criadoEm: new Date().toISOString()
            };
        }

        pagamentos[paymentId].status = status;

        if (status === 'approved' && pagamentos[paymentId].numero === null) {
            const numero = gerarNumeroUnico();
            pagamentos[paymentId].numero = numero;
            pagamentos[paymentId].aprovadoEm = new Date().toISOString();

            console.log(`✅ Pagamento aprovado. Número gerado para ${paymentId}: ${numero}`);
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('Erro no webhook:', error);
        return res.sendStatus(500);
    }
});

// Consultar status do pagamento
app.get('/status-pagamento/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const pagamentoLocal = pagamentos[id];

        if (!pagamentoLocal) {
            return res.status(404).json({ erro: 'Pagamento não encontrado' });
        }

        return res.json({
            id: pagamentoLocal.id,
            status: pagamentoLocal.status,
            numero: pagamentoLocal.numero,
            nome: pagamentoLocal.nome
        });
    } catch (error) {
        console.error('Erro ao consultar status:', error);
        return res.status(500).json({
            erro: 'Erro ao consultar status'
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});