const express = require('express');
const { buscarPorDescricao, buscarPorPrincipioAtivo, buscarPorPrincipioAtivoIds, verificarDisponibilidade } = require('../db/queries');
const { enriquecerClassificacaoCanonica } = require('../db/classificacaoQueries');
const { ordenarPorIA } = require('../services/aiService');
const { analisarNecessidadeDeClarificacao } = require('../services/clarificacaoService');
const { classificarTipoBusca, extrairFormaFarmaceutica } = require('../utils/searchUtils');

const router = express.Router();

const UNIDADE_NEGOCIO_ID_PADRAO = parseInt(process.env.UNIDADE_NEGOCIO_ID || '65984');

function normalizarIdOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') {
    return null;
  }

  const id = Number.parseInt(valor, 10);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

function descreverProdutoParaLog(produto) {
  if (!produto) {
    return 'produto indefinido';
  }

  const partes = [
    `id=${produto.id ?? 'n/a'}`,
    `emb=${produto.embalagem_id ?? 'n/a'}`,
    `origem=${produto.origem ?? 'n/a'}`,
    `sql=${produto.relevancia_descricao ?? 0}`,
    `ia=${produto.relevancia_score ?? 'n/a'}`
  ];

  if (produto.principioativo_nome) {
    partes.push(`pa=${produto.principioativo_nome}`);
  }

  return `${partes.join(' | ')} | ${String(produto.descricao || '').substring(0, 90)}`;
}

function logResumoProdutos(etapa, produtos, limite = 5) {
  const lista = Array.isArray(produtos) ? produtos : [];
  console.log(`[TRACE] ${etapa} | total=${lista.length}`);

  if (lista.length === 0) {
    return;
  }

  lista.slice(0, limite).forEach((produto, idx) => {
    console.log(`         ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (lista.length > limite) {
    console.log(`         ... +${lista.length - limite} produto(s)`);
  }
}

function logDistribuicao(etapa, produtos, campo) {
  const lista = Array.isArray(produtos) ? produtos : [];
  const contagem = new Map();

  lista.forEach(produto => {
    const chave = produto?.[campo] || 'SEM_VALOR';
    contagem.set(chave, (contagem.get(chave) || 0) + 1);
  });

  const resumo = [...contagem.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([chave, total]) => `${chave}:${total}`)
    .join(' | ');

  console.log(`[TRACE] ${etapa} | ${campo} => ${resumo || 'vazio'}`);
}

router.post('/api/buscar-medicamentos', async (req, res) => {
  try {
    const { query, unidade_negocio_id } = req.body;
    const cadernoOfertaId = normalizarIdOpcional(
      req.body.caderno_oferta_id ?? req.body.cadernoOfertaId ?? req.body.caderno_id
    );

    if (!query || query.trim() === '') {
      return res.status(400).json({ erro: 'Query vazia' });
    }

    if (Number.isNaN(cadernoOfertaId)) {
      return res.status(400).json({ erro: 'caderno_oferta_id inválido' });
    }

    const unidadeNegocioId = unidade_negocio_id || UNIDADE_NEGOCIO_ID_PADRAO;
    const termoBusca = query.trim().toLowerCase();

    console.log(`\n========================================`);
    console.log(`[BUSCA] Termo: "${termoBusca}"`);
    console.log(`[BUSCA] Unidade Negócio ID: ${unidadeNegocioId}`);
    console.log(`[BUSCA] Caderno Oferta ID: ${cadernoOfertaId || 'não informado'}`);
    console.log(`========================================`);

    const { principioAtivoBusca, formaFarmaceutica, variacoesForma } = extrairFormaFarmaceutica(termoBusca);

    console.log(`[INFO] Princípio ativo extraído: "${principioAtivoBusca}"`);
    console.log(`[INFO] Forma farmacêutica: "${formaFarmaceutica || 'nenhuma'}"`);

    let produtosPrincipioAtivo = [];
    let produtosDescricao = [];
    let principiosEncontrados = [];
    let metodosUtilizados = [];

    const [resultadoPrincipioAtivo, resultadoDescricao] = await Promise.all([
      buscarPorPrincipioAtivo(principioAtivoBusca, formaFarmaceutica, variacoesForma),
      buscarPorDescricao(termoBusca)
    ]);

    if (resultadoPrincipioAtivo.encontrado) {
      produtosPrincipioAtivo = resultadoPrincipioAtivo.produtos;
      principiosEncontrados = resultadoPrincipioAtivo.principiosEncontrados || [];
      metodosUtilizados.push(resultadoPrincipioAtivo.metodo);
      console.log(`[TRACE] Principios ativos encontrados: ${principiosEncontrados.map(p => p.nome).slice(0, 10).join(' | ') || 'nenhum'}`);
      logResumoProdutos('Resultado bruto por principio ativo', produtosPrincipioAtivo);
    }

    if (resultadoDescricao.produtos && resultadoDescricao.produtos.length > 0) {
      produtosDescricao = resultadoDescricao.produtos;
      metodosUtilizados.push(resultadoDescricao.metodo);
      logResumoProdutos('Resultado bruto por descricao', produtosDescricao);
    }

    const tipoBusca = classificarTipoBusca({
      termoBusca,
      principioAtivoBusca,
      produtosDescricao,
      principiosEncontrados
    });
    const termoNominalBusca = principioAtivoBusca || termoBusca;

    console.log(`[INFO] Tipo de busca classificado: "${tipoBusca}"`);
    console.log(`[INFO] Termo nuclear da busca: "${termoNominalBusca}"`);

    const principioAtivoIdsDaDescricao = [...new Set(
      produtosDescricao
        .map(p => p.principioativo_id)
        .filter(id => id !== null && id !== undefined)
    )];

    if (principioAtivoIdsDaDescricao.length > 0) {
      console.log(`[TRACE] IDs de principio ativo herdados da descricao: ${principioAtivoIdsDaDescricao.slice(0, 10).join(', ')}`);
      const resultadoExpandidoPorPrincipio = await buscarPorPrincipioAtivoIds(
        principioAtivoIdsDaDescricao.slice(0, 10),
        formaFarmaceutica,
        variacoesForma
      );

      if (resultadoExpandidoPorPrincipio.encontrado) {
        produtosPrincipioAtivo = [...produtosPrincipioAtivo, ...resultadoExpandidoPorPrincipio.produtos];
        metodosUtilizados.push(resultadoExpandidoPorPrincipio.metodo);
        logResumoProdutos('Resultado expandido por principio ativo vindo da descricao', resultadoExpandidoPorPrincipio.produtos);
      }
    }

    const produtosMap = new Map();

    produtosPrincipioAtivo.forEach(p => {
      produtosMap.set(p.id, { ...p, origem: 'principio_ativo' });
    });

    produtosDescricao.forEach(p => {
      if (!produtosMap.has(p.id)) {
        produtosMap.set(p.id, { ...p, origem: 'descricao' });
      } else {
        const produto = produtosMap.get(p.id);
        produto.origem = 'ambos';
        produto.relevancia_descricao = p.relevancia_descricao;
        produtosMap.set(p.id, produto);
      }
    });

    let produtos = Array.from(produtosMap.values());

    produtos.sort((a, b) => {
      const scoreA = a.relevancia_descricao || 0;
      const scoreB = b.relevancia_descricao || 0;
      return scoreB - scoreA;
    });

    console.log(`[INFO] Total de produtos únicos combinados: ${produtos.length}`);
    logDistribuicao('Distribuicao apos merge', produtos, 'origem');
    logResumoProdutos('Produtos combinados apos merge e ordenacao SQL', produtos);

    if (produtos.length > 0) {
      produtos = await verificarDisponibilidade(produtos, unidadeNegocioId, cadernoOfertaId);
      console.log(`[INFO] Após verificação de estoque: ${produtos.length} produtos`);
      logResumoProdutos('Produtos apos filtro de estoque', produtos);
    }

    if (produtos.length > 0) {
      produtos = await enriquecerClassificacaoCanonica(produtos);
      logDistribuicao('Distribuicao apos classificacao canonica', produtos, 'tipo_classificacao_canonica');
      logResumoProdutos('Produtos apos enriquecimento de classificacao', produtos);
    }

    let ordenadoPorIA = false;
    let filtradoPorIA = false;
    let avaliadoPorIA = false;
    let estatisticasIA = { aprovados: 0, rejeitados: 0, analisados: 0 };
    console.log(`[INFO] Iniciando IA para marcar candidatos`);
    if (produtos.length > 0 ) {
      logResumoProdutos('Candidatos enviados para etapa de IA', produtos);
      const resultadoIA = await ordenarPorIA(produtos, {
        termoBusca,
        termoNominalBusca,
        tipoBusca,
        principioAtivoBusca,
        formaFarmaceutica
      });
      produtos = resultadoIA.produtos;
      ordenadoPorIA = resultadoIA.ordenado;
      filtradoPorIA = resultadoIA.filtrado;
      avaliadoPorIA = resultadoIA.avaliado === true;
      estatisticasIA = resultadoIA.estatisticasIA || estatisticasIA;
      logResumoProdutos('Produtos apos marcacao da IA', produtos);
    }

    const produtosParaClarificacao = produtos.filter(produto => produto.relacionado_busca !== false);
    console.log(
      `[CLARIFICACAO] Base considerada para clarificacao: ${produtosParaClarificacao.length} produto(s)`
    );
    const clarificacao = analisarNecessidadeDeClarificacao({
      query: termoBusca,
      produtos: produtosParaClarificacao
    });

    console.log(
      `[CLARIFICACAO] ${clarificacao.precisa_clarificar ? 'Necessaria' : 'Nao'} ` +
      `| Produtos analisados: ${clarificacao.total_produtos_analisados || 0}`
    );
    if (clarificacao.precisa_clarificar) {
      console.log(`[CLARIFICACAO] Pergunta: ${clarificacao.pergunta}`);
      console.log(`[CLARIFICACAO] Opcoes: ${(clarificacao.opcoes || []).join(' | ')}`);
    }

    const metodoBusca = metodosUtilizados.length > 0
      ? metodosUtilizados.join(' + ')
      : 'nenhum método encontrou resultados';
    const classificacoesDisponiveis = [...new Set(produtos.map(p => p.tipo_classificacao_canonica).filter(Boolean))];
    const classificacoesNaoMapeadas = [...new Set(
      produtos
        .filter(p => p.tipo_classificacao_canonica === 'DESCONHECIDO')
        .map(p => `${p.classificacao_id_origem || 'sem_id'}:${p.classificacao_nome_origem || 'sem_nome'}`)
    )];
    const produtosAlternativosMesmoPrincipioAtivo = produtos
      .filter(p => p.tipo_relacao_busca === 'alternativa_mesmo_principio_ativo')
      .length;

    console.log(`\n========================================`);
    console.log(`[RESULTADO] ${produtos.length} produto(s) encontrado(s)`);
    console.log(`[RESULTADO] Métodos: ${metodoBusca}`);
    console.log(`[RESULTADO] Tipo de busca: ${tipoBusca}`);
    console.log(`[RESULTADO] Ordenado por IA: ${ordenadoPorIA ? 'Sim' : 'Não'}`);
    console.log(`[RESULTADO] Filtrado por IA: ${filtradoPorIA ? 'Sim' : 'Não'}`);
    console.log(`[RESULTADO] Avaliado por IA: ${avaliadoPorIA ? 'Sim' : 'Não'}`);
    console.log(
      `[RESULTADO] IA relacionados=${estatisticasIA.aprovados} | nao_relacionados=${estatisticasIA.rejeitados} | analisados=${estatisticasIA.analisados}`
    );
    logDistribuicao('Distribuicao final por origem', produtos, 'origem');
    logDistribuicao('Distribuicao final por classificacao', produtos, 'tipo_classificacao_canonica');
    logDistribuicao('Distribuicao final por tipo relacao busca', produtos, 'tipo_relacao_busca');
    logResumoProdutos('Resultado final retornado', produtos);
    console.log(`========================================\n`);

    return res.status(200).json({
      busca: {
        termo_original: termoBusca,
        tipo_busca: tipoBusca,
        principio_ativo_extraido: String(tipoBusca || '').startsWith('principio_ativo')
          ? (principioAtivoBusca || null)
          : null,
        forma_farmaceutica: formaFarmaceutica
      },
      metadados: {
        metodo_busca: metodoBusca,
        ordenado_por_ia: ordenadoPorIA,
        filtrado_por_ia: filtradoPorIA,
        avaliado_por_ia: avaliadoPorIA,
        produtos_relacionados_busca_ia: estatisticasIA.aprovados,
        produtos_nao_relacionados_busca_ia: estatisticasIA.rejeitados,
        produtos_analisados_ia: estatisticasIA.analisados,
        produtos_alternativos_mesmo_principio_ativo: produtosAlternativosMesmoPrincipioAtivo,
        busca_ambigua: clarificacao.precisa_clarificar,
        total_produtos: produtos.length,
        unidade_negocio_id: unidadeNegocioId,
        caderno_oferta_id: cadernoOfertaId,
        classificacoes_disponiveis: classificacoesDisponiveis,
        classificacoes_nao_mapeadas: classificacoesNaoMapeadas
      },
      clarificacao,
      produtos: produtos.map(p => ({
        id: p.id,
        codigo: p.codigo,
        codigo_barras: p.codigobarras,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        tipo_classificacao: p.tipo_classificacao_canonica || null,
        classificacao_id_origem: p.classificacao_id_origem || null,
        classificacao_nome_origem: p.classificacao_nome_origem || null,
        embalagem_id: p.embalagem_id,
        estoque_disponivel: p.estoque_disponivel || 0,
        relevancia_score: p.relevancia_score || p.relevancia_descricao || null,
        relacionado_busca: p.relacionado_busca ?? null,
        tipo_relacao_busca: p.tipo_relacao_busca ?? null,
        origem_busca: p.origem,
        precos: {
          preco_venda: p.precos?.preco_final_venda || null,
          tem_oferta_ativa: p.precos?.tem_oferta_ativa || false,
          preco_sem_desconto: p.precos?.preco_sem_desconto || null,
          preco_com_desconto: p.precos?.preco_com_desconto || null,
          desconto_percentual: p.precos?.desconto_oferta_percentual || null,
          nome_caderno_oferta: p.precos?.nome_caderno_oferta || null,
          caderno_oferta_id: p.precos?.caderno_oferta_id || null,
          caderno_oferta_id_solicitado: p.precos?.caderno_oferta_id_solicitado || null,
          origem_oferta: p.precos?.origem_oferta || null,
          tipo_oferta: p.precos?.tipo_oferta || null,
          leve: p.precos?.leve || null,
          pague: p.precos?.pague || null,
          desconto_leve_pague: p.precos?.desconto_leve_pague || null,
          ofertas_caderno: p.precos?.ofertas_caderno || [],
          oferta_inicio: p.precos?.oferta_inicio || null,
          oferta_fim: p.precos?.oferta_fim || null,
          preco_referencial_geral: p.precos?.preco_referencial_geral || null,
          preco_venda_geral: p.precos?.preco_venda_geral || null,
          preco_referencial_loja: p.precos?.preco_referencial_loja || null,
          preco_venda_loja: p.precos?.preco_venda_loja || null,
          markup_geral: p.precos?.markup_geral || null,
          markup_loja: p.precos?.markup_loja || null,
          plugpharma_preco_controlado: p.precos?.plugpharma_preco_controlado || null
        }
      }))
    });
  } catch (error) {
    console.error('❌ Erro ao buscar medicamento:', error);
    return res.status(500).json({
      erro: 'Erro ao processar busca',
      detalhes: error.message
    });
  }
});

router.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

module.exports = { router };
