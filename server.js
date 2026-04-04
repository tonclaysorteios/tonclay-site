const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

app.use(cors());
app.use(express.json());

const clientMP = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

const paymentApi = new Payment(clientMP);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'tonclay123';
const TOTAL_NUMEROS_VENDA = Number(process.env.TOTAL_NUMEROS_VENDA || 300);

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurada no Render');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

function authAdmin(req, res, next) {
    const token = req.query.token;
    if (token !== ADMIN_TOKEN) {
        return res.status(401).json({ erro: 'Não autorizado' });
    }
    next();
}

async function initDb() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      payment_id TEXT PRIMARY KEY,
      nome TEXT,
      email TEXT,
      whatsapp TEXT,
      status TEXT DEFAULT 'pending',
      numeros JSONB DEFAULT '[]'::jsonb,
      valor NUMERIC(10,2) DEFAULT 0,
      quantidade INTEGER DEFAULT 1,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW(),
      aprovado_em TIMESTAMPTZ
    )
  `);
}

function normalizePedido(row) {
    return {
        paymentId: row.payment_id,
        nome: row.nome || '',
        email: row.email || '',
        whatsapp: row.whatsapp || '',
        status: row.status || 'pending',
        numeros: Array.isArray(row.numeros) ? row.numeros : [],
        valor: Number(row.valor || 0),
        quantidade: Number(row.quantidade || 1),
        criadoEm: row.criado_em,
        atualizadoEm: row.atualizado_em,
        aprovadoEm: row.aprovado_em
    };
}

async function getAllAssignedNumbers() {
    const result = await pool.query(`
    SELECT numeros
    FROM pedidos
    WHERE jsonb_array_length(numeros) > 0
  `);

    const usados = [];
    for (const row of result.rows) {
        if (Array.isArray(row.numeros)) {
            usados.push(...row.numeros);
        }
    }
    return usados;
}

async function getTotalAssignedCount() {
    const result = await pool.query(`
    SELECT COALESCE(SUM(jsonb_array_length(numeros)), 0) AS total
    FROM pedidos
  `);
    return Number(result.rows[0]?.total || 0);
}

async function gerarNumerosUnicos(quantidade = 1) {
    const usados = await getAllAssignedNumbers();

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
    return html.replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
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

    return unicos.sort((a, b) => a.premio - b.premio).slice(0, 5);
}

function conferirNumeroContraFederal(numeroComprado, resultados) {
    const finais = resultados.map(r => r.numero);

    return {
        exato: finais.includes(numeroComprado),
        milhar: finais.some(n => n.slice(-4) === numeroComprado.slice(-4)),
        centena: finais.some(n => n.slice(-3) === numeroComprado.slice(-3)),
        dezena: finais.some(n => n.slice(-2) === numeroComprado.slice(-2))
    };
}

async function encontrarVencedores(resultados) {
    const result = await pool.query(`
    SELECT *
    FROM pedidos
    WHERE jsonb_array_length(numeros) > 0
    ORDER BY criado_em DESC
  `);

    const vencedores = [];

    for (const row of result.rows) {
        const pedido = normalizePedido(row);

        for (const numero of pedido.numeros) {
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

app.get('/', (req, res) => {
    res.send('Servidor rodando 🔥');
});

app.get('/health', async (req, res) => {
    try {
        const totalPedidosRes = await pool.query(`SELECT COUNT(*)::int AS total FROM pedidos`);
        const totalNumerosVendidos = await getTotalAssignedCount();

        return res.json({
            ok: true,
            banco: 'postgres',
            totalPedidos: totalPedidosRes.rows[0].total,
            totalNumerosVendidos,
            limiteVenda: TOTAL_NUMEROS_VENDA
        });
    } catch (error) {
        console.error('❌ Erro no health:', error);
        return res.status(500).json({
            ok: false,
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
                description: `Participação sorteio TonClay (${qtd} bilhete${qtd > 1 ? 's' : ''})`,
                payment_method_id: 'pix',
                payer: {
                    email,
                    first_name: nome
                },
                notification_url: 'https://tonclay-backend.onrender.com/webhook'
            }
        });

        const transactionData = pagamento?.point_of_interaction?.transaction_data || {};

        await pool.query(`
      INSERT INTO pedidos (
        payment_id, nome, email, whatsapp, status, numeros, valor, quantidade, criado_em, atualizado_em
      )
      VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7,NOW(),NOW())
      ON CONFLICT (payment_id) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        whatsapp = EXCLUDED.whatsapp,
        status = EXCLUDED.status,
        valor = EXCLUDED.valor,
        quantidade = EXCLUDED.quantidade,
        atualizado_em = NOW()
    `, [
            String(pagamento.id),
            nome,
            email,
            whatsapp || '',
            pagamento.status || 'pending',
            valorTotal,
            qtd
        ]);

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

        const pedidoRes = await pool.query(`
      SELECT *
      FROM pedidos
      WHERE payment_id = $1
      LIMIT 1
    `, [String(paymentId)]);

        if (pedidoRes.rows.length === 0) {
            await pool.query(`
        INSERT INTO pedidos (
          payment_id, status, numeros, valor, quantidade, criado_em, atualizado_em
        )
        VALUES ($1,$2,'[]'::jsonb,10,1,NOW(),NOW())
        ON CONFLICT (payment_id) DO NOTHING
      `, [String(paymentId), status]);
        }

        const atualRes = await pool.query(`
      SELECT *
      FROM pedidos
      WHERE payment_id = $1
      LIMIT 1
    `, [String(paymentId)]);

        const pedido = normalizePedido(atualRes.rows[0]);

        if (status === 'approved' && (!pedido.numeros || pedido.numeros.length === 0)) {
            const numeros = await gerarNumerosUnicos(pedido.quantidade || 1);

            if (!numeros) {
                await pool.query(`
          UPDATE pedidos
          SET status = $2, atualizado_em = NOW()
          WHERE payment_id = $1
        `, [String(paymentId), 'approved']);
                return res.sendStatus(200);
            }

            await pool.query(`
        UPDATE pedidos
        SET status = $2,
            numeros = $3::jsonb,
            aprovado_em = NOW(),
            atualizado_em = NOW()
        WHERE payment_id = $1
      `, [String(paymentId), status, JSON.stringify(numeros)]);

            console.log(`✅ Pagamento aprovado. Números gerados para ${paymentId}: ${numeros.join(', ')}`);
        } else {
            await pool.query(`
        UPDATE pedidos
        SET status = $2, atualizado_em = NOW()
        WHERE payment_id = $1
      `, [String(paymentId), status]);
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        return res.sendStatus(500);
    }
});

app.get('/status-pagamento/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
      SELECT *
      FROM pedidos
      WHERE payment_id = $1
      LIMIT 1
    `, [String(id)]);

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'Pagamento não encontrado' });
        }

        const pedido = normalizePedido(result.rows[0]);

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

app.get('/admin-pedidos', authAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
      SELECT *
      FROM pedidos
      ORDER BY criado_em DESC
    `);

        const pedidos = result.rows.map(normalizePedido);
        const totalNumerosVendidos = pedidos.reduce((acc, p) => acc + (p.numeros?.length || 0), 0);

        return res.json({
            total: pedidos.length,
            totalNumerosVendidos,
            limiteVenda: TOTAL_NUMEROS_VENDA,
            pedidos
        });
    } catch (error) {
        console.error('❌ Erro ao listar pedidos:', error);
        return res.status(500).json({ erro: 'Erro ao listar pedidos' });
    }
});

app.get('/admin-buscar-numero/:numero', authAdmin, async (req, res) => {
    try {
        const numero = String(req.params.numero).padStart(5, '0');

        const result = await pool.query(`
      SELECT *
      FROM pedidos
      WHERE numeros ? $1
      LIMIT 1
    `, [numero]);

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'Número não encontrado' });
        }

        return res.json({
            numero,
            pedido: normalizePedido(result.rows[0])
        });
    } catch (error) {
        console.error('❌ Erro ao buscar número:', error);
        return res.status(500).json({ erro: 'Erro ao buscar número' });
    }
});

app.get('/admin-resultado-federal', authAdmin, async (req, res) => {
    try {
        const response = await fetch('https://loterias.caixa.gov.br/Paginas/Federal.aspx', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const html = await response.text();
        const resultados = extrairResultadosFederal(html);

        if (!resultados || resultados.length < 5) {
            return res.status(500).json({
                erro: 'Não foi possível extrair os 5 resultados da Federal'
            });
        }

        const vencedores = await encontrarVencedores(resultados);

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

app.get('/admin-exportar-csv', authAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
      SELECT *
      FROM pedidos
      ORDER BY criado_em DESC
    `);

        const linhas = [
            ['Nome', 'WhatsApp', 'Email', 'Status', 'Quantidade', 'Valor', 'Numeros', 'PaymentID', 'CriadoEm'].join(';')
        ];

        result.rows.map(normalizePedido).forEach(p => {
            linhas.push([
                p.nome || '',
                p.whatsapp || '',
                p.email || '',
                p.status || '',
                p.quantidade || 1,
                p.valor || 0,
                (p.numeros || []).join(','),
                p.paymentId || '',
                p.criadoEm || ''
            ].join(';'));
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=pedidos_tonclay.csv');
        return res.send('\uFEFF' + linhas.join('\n'));
    } catch (error) {
        console.error('❌ Erro ao exportar CSV:', error);
        return res.status(500).json({ erro: 'Erro ao exportar CSV' });
    }
});

const PORT = process.env.PORT || 3000;

(async () => {
    try {
        await initDb();
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Servidor rodando na porta ${PORT}`);
        });
    } catch (error) {
        console.error('❌ Falha ao iniciar servidor:', error);
        process.exit(1);
    }
})();