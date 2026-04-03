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

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'tonclay123';

// Quantos números você quer vender no sorteio atual
// Ex.: 300 números vendidos, mas cada um é um código de 5 dígitos
const TOTAL_NUMEROS_VENDA = Number(process.env.TOTAL_NUMEROS_VENDA || 300);

// Memória temporária
const pedidos = {};

// Gera números únicos de 5 dígitos
function gerarNumerosUnicos(quantidade = 1) {
    const usados = Object.values(pedidos)
        .flatMap(p => Array.isArray(p.numeros) ? p.numeros : []);

    if (usados.length + quantidade > TOTAL_NUMEROS_VENDA) {
        return null;
    }

    const novosNumeros = [];

    while (novosNumeros.length < quantidade) {
        const numero = String(Math.floor(Math.random() * 100000)).padStart(5, '0');

        if (!usados.includes(numero) && !novosNumeros.includes(numero)) {
            novosNumeros.push(numero);
        }
    }

    return novosNumeros;
}

function normalizeText(html) {
    return html
        .replace(/\s+/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

function extrairResultadosFederal(html) {
    const texto = normalizeText(html);

    const regex = /([1-5])º[^0-9]{0,40}(\d{5})/g;
    const encontrados = [];
    let match;

    while ((match = regex.exec(texto)) !== null) {
        encontrados.push({
            premio: Number(match[1]),
            numero: match[2]
        });
    }

    const unicos = [];
    const vistos = new Set();

    for (const item of encontrados) {
        const chave = `${item.premio}-${item.numero}`;
        if (!vistos.has(chave)) {
            vistos.add(chave);
            unicos.push(item);
        }
    }

    return unicos
        .sort((a, b) => a.premio - b.premio)
        .slice(0, 5);
}

function conferirNumeroContraFederal(numeroComprado, resultados) {
    const finais = resultados.map(r => r.numero);

    const matches = {
        exato: finais.includes(numeroComprado),
        milhar: finais.some(n => n.slice(-4) === numeroComprado.slice(-4)),
        centena: finais.some(n => n.slice(-3) === numeroComprado.slice(-3)),
        dezena: finais.some(n => n.slice(-2) === numeroComprado.slice(-2))
    };

    return matches;
}

function encontrarVencedores(resultados) {
    const listaPedidos = Object.values(pedidos);

    const vencedores = [];

    for (const pedido of listaPedidos) {
        const numeros = Array.isArray(pedido.numeros) ? pedido.numeros : [];

        for (const numero of numeros) {
            const match = conferirNumeroContraFederal(numero, resultados);

            if (match.exato || match.milhar || match.centena || match.dezena) {
                vencedores.push({
                    nome: pedido.nome,
                    whatsapp: pedido.whatsapp,
                    email: pedido.email,
                    paymentId: pedido.paymentId,
                    numero,
                    match
                });
            }
        }
    }

    return vencedores;
}

function authAdmin(req, res, next) {
    const token = req.query.token;
    if (token !== ADMIN_TOKEN) {
        return res.status(401).json({ erro: 'Não autorizado' });
    }
    next();
}

app.get('/', (req, res) => {
    res.send('Servidor rodando 🔥');
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        banco: 'desativado_temporariamente',
        totalPedidos: Object.keys(pedidos).length,
        totalNumerosVendidos: Object.values(pedidos).reduce((acc, p) => acc + ((p.numeros || []).length), 0),
        limiteVenda: TOTAL_NUMEROS_VENDA
    });
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
            criadoEm: new Date().toISOString(),
            atualizadoEm: new Date().toISOString()
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
                criadoEm: new Date().toISOString(),
                atualizadoEm: new Date().toISOString()
            };
        }

        const pedido = pedidos[String(paymentId)];
        pedido.status = status;
        pedido.atualizadoEm = new Date().toISOString();

        if (status === 'approved' && (!pedido.numeros || pedido.numeros.length === 0)) {
            const numeros = gerarNumerosUnicos(pedido.quantidade || 1);
            pedido.numeros = numeros || [];
            pedido.aprovadoEm = new Date().toISOString();

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

app.get('/admin-pedidos', authAdmin, (req, res) => {
    try {
        const lista = Object.values(pedidos)
            .sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));

        return res.json({
            total: lista.length,
            totalNumerosVendidos: lista.reduce((acc, p) => acc + ((p.numeros || []).length), 0),
            limiteVenda: TOTAL_NUMEROS_VENDA,
            pedidos: lista
        });
    } catch (error) {
        console.error('❌ Erro ao listar pedidos:', error);
        return res.status(500).json({ erro: 'Erro ao listar pedidos' });
    }
});

app.get('/admin-buscar-numero/:numero', authAdmin, (req, res) => {
    try {
        const numero = String(req.params.numero).padStart(5, '0');

        const dono = Object.values(pedidos).find(p =>
            Array.isArray(p.numeros) && p.numeros.includes(numero)
        );

        if (!dono) {
            return res.status(404).json({ erro: 'Número não encontrado' });
        }

        return res.json({
            numero,
            pedido: dono
        });
    } catch (error) {
        console.error('❌ Erro ao buscar número:', error);
        return res.status(500).json({ erro: 'Erro ao buscar número' });
    }
});

// Busca resultado oficial da Federal na página da CAIXA
app.get('/admin-resultado-federal', authAdmin, async (req, res) => {
    try {
        const response = await fetch('https://loterias.caixa.gov.br/Paginas/Federal.aspx', {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const html = await response.text();
        const resultados = extrairResultadosFederal(html);

        if (!resultados || resultados.length < 5) {
            return res.status(500).json({
                erro: 'Não foi possível extrair os 5 resultados da Federal da página oficial da CAIXA'
            });
        }

        const vencedores = encontrarVencedores(resultados);

        return res.json({
            fonte: 'CAIXA Federal',
            resultados,
            vencedores
        });
    } catch (error) {
        console.error('❌ Erro ao consultar Federal:', error);
        return res.status(500).json({
            erro: 'Erro ao consultar resultado da Federal',
            detalhe: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});