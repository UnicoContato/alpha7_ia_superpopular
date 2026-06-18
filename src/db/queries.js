const { pool } = require('./pool');
const { expandirAbreviacoes, gerarCondicoesBuscaComRanking } = require('../../abreviacoes');

function toFloatOrNull(valor) {
  const numero = parseFloat(valor);
  return Number.isNaN(numero) ? null : numero;
}

function calcularPrecoFinalOfertaCaderno(oferta, precoAtual) {
  if (oferta.tipooferta === 'P' && oferta.preco_fixo !== null) {
    return oferta.preco_fixo;
  }

  if (oferta.tipooferta === 'D' && oferta.preco_com_desconto !== null) {
    return oferta.preco_com_desconto;
  }

  return precoAtual;
}

async function buscarPrecosEOfertas(embalagemIds, unidadeNegocioId, cadernoOfertaId = null) {
  console.log(`\n[PREÇOS] Buscando preços e ofertas para ${embalagemIds.length} embalagens...`);
  if (cadernoOfertaId) {
    console.log(`[PREÇOS] Caderno de oferta solicitado: ${cadernoOfertaId}`);
  }

  if (embalagemIds.length === 0) {
    return {};
  }

  try {
    const placeholders = embalagemIds.map((_, idx) => `$${idx + 1}`).join(',');

    const query = `
      SELECT 
        em.id as embalagem_id,
        
        -- Preços da tabela EMBALAGEM (padrão geral)
        em.precoreferencial as preco_referencial_geral,
        em.precovenda as preco_venda_geral,
        em.markup as markup_geral,
        
        -- Preços específicos da UNIDADE DE NEGÓCIO
        peu.precoreferencial as preco_referencial_loja,
        peu.precovenda as preco_venda_loja,
        peu.markup as markup_loja,
        peu.plugpharmaprecocontrolado,
        
        -- Melhor oferta ativa
        mo.precooferta as preco_melhor_oferta,
        mo.descontooferta as desconto_oferta_percentual,
        mo.precounitariosemdesconto as preco_sem_desconto,
        mo.precounitariocomdesconto as preco_com_desconto,
        mo.vigenciainicio as oferta_inicio,
        mo.vigenciatermino as oferta_fim,
        mo.cadernoofertaid as caderno_oferta_id,
        
        -- Caderno de oferta relacionado
        co.nome as nome_caderno_oferta,
        ico.tipooferta,
        ico.leve,
        ico.pague,
        
        -- Preço FINAL (lógica de prioridade)
        CASE
          WHEN mo.precooferta IS NOT NULL 
            AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
          THEN mo.precooferta
          WHEN peu.precovenda IS NOT NULL 
          THEN peu.precovenda
          ELSE em.precovenda
        END as preco_final_venda,
        
        -- Indicador de oferta ativa
        CASE
          WHEN mo.precooferta IS NOT NULL 
            AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
          THEN true
          ELSE false
        END as tem_oferta_ativa

      FROM embalagem em
      
      LEFT JOIN precoembalagemunidadenegocio peu 
        ON peu.embalagemid = em.id 
        AND peu.unidadenegocioid = $${embalagemIds.length + 1}
      
      LEFT JOIN melhoroferta mo 
        ON mo.embalagemid = em.id 
        AND mo.unidadenegocioid = $${embalagemIds.length + 1}
        AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
      
      LEFT JOIN itemcadernooferta ico 
        ON ico.id = (
          SELECT ico2.id 
          FROM itemcadernooferta ico2
          WHERE ico2.embalagemid = em.id 
            AND ico2.cadernoofertaid = mo.cadernoofertaid
          LIMIT 1
        )
      
      LEFT JOIN cadernooferta co 
        ON co.id = mo.cadernoofertaid
      
      WHERE em.id IN (${placeholders})
    `;

    const params = [...embalagemIds, unidadeNegocioId];
    const resultado = await pool.query(query, params);

    const precosMap = {};
    resultado.rows.forEach(row => {
      precosMap[row.embalagem_id] = {
        preco_referencial_geral: toFloatOrNull(row.preco_referencial_geral),
        preco_venda_geral: toFloatOrNull(row.preco_venda_geral),
        markup_geral: toFloatOrNull(row.markup_geral),
        preco_referencial_loja: toFloatOrNull(row.preco_referencial_loja),
        preco_venda_loja: toFloatOrNull(row.preco_venda_loja),
        markup_loja: toFloatOrNull(row.markup_loja),
        plugpharma_preco_controlado: toFloatOrNull(row.plugpharmaprecocontrolado),
        preco_melhor_oferta: toFloatOrNull(row.preco_melhor_oferta),
        desconto_oferta_percentual: toFloatOrNull(row.desconto_oferta_percentual),
        preco_sem_desconto: toFloatOrNull(row.preco_sem_desconto),
        preco_com_desconto: toFloatOrNull(row.preco_com_desconto),
        oferta_inicio: row.oferta_inicio,
        oferta_fim: row.oferta_fim,
        nome_caderno_oferta: row.nome_caderno_oferta,
        caderno_oferta_id: row.caderno_oferta_id,
        caderno_oferta_id_solicitado: cadernoOfertaId,
        tipo_oferta: row.tipooferta,
        leve: row.leve,
        pague: row.pague,
        desconto_leve_pague: null,
        preco_final_venda: toFloatOrNull(row.preco_final_venda),
        tem_oferta_ativa: row.tem_oferta_ativa || false,
        origem_oferta: row.tem_oferta_ativa ? 'melhoroferta' : null,
        ofertas_caderno: []
      };
    });

    if (cadernoOfertaId) {
      const cadernoParamIdx = embalagemIds.length + 1;
      const ofertasCaderno = await pool.query(`
        SELECT
          em.id as embalagem_id,
          p.descricao as produto,
          em.codigobarras as ean,
          em.precovenda as preco_normal,
          co.nome as caderno,
          co.id as caderno_id,
          ic.tipooferta,
          ic.descontooferta as desconto_pct,
          ROUND(em.precovenda * (1 - ic.descontooferta / 100), 2) as preco_com_desconto,
          ic.leve,
          ic.pague,
          ic.descontolevepague,
          ic.precooferta as preco_fixo
        FROM itemcadernooferta ic
        JOIN embalagem em ON em.id = ic.embalagemid
        JOIN produto p ON p.id = em.produtoid
        JOIN cadernooferta co ON co.id = ic.cadernoofertaid
        WHERE em.id IN (${placeholders})
          AND co.status = 'A'
          AND co.id = $${cadernoParamIdx}
        ORDER BY em.id, ic.tipooferta
      `, [...embalagemIds, cadernoOfertaId]);

      const ofertasPorEmbalagem = {};
      ofertasCaderno.rows.forEach(row => {
        const oferta = {
          produto: row.produto,
          ean: row.ean,
          preco_normal: toFloatOrNull(row.preco_normal),
          caderno: row.caderno,
          caderno_id: row.caderno_id,
          tipo_oferta: row.tipooferta,
          desconto_pct: toFloatOrNull(row.desconto_pct),
          preco_com_desconto: toFloatOrNull(row.preco_com_desconto),
          leve: row.leve,
          pague: row.pague,
          desconto_leve_pague: toFloatOrNull(row.descontolevepague),
          preco_fixo: toFloatOrNull(row.preco_fixo)
        };

        if (!ofertasPorEmbalagem[row.embalagem_id]) {
          ofertasPorEmbalagem[row.embalagem_id] = [];
        }

        ofertasPorEmbalagem[row.embalagem_id].push(oferta);
      });

      Object.entries(ofertasPorEmbalagem).forEach(([embalagemId, ofertas]) => {
        const precoInfo = precosMap[embalagemId];
        if (!precoInfo || ofertas.length === 0) {
          return;
        }

        const ofertaPrincipal = ofertas.find(oferta => oferta.tipo_oferta === 'P')
          || ofertas.find(oferta => oferta.tipo_oferta === 'D')
          || ofertas[0];
        const precoFinalOferta = calcularPrecoFinalOfertaCaderno(
          {
            tipooferta: ofertaPrincipal.tipo_oferta,
            preco_fixo: ofertaPrincipal.preco_fixo,
            preco_com_desconto: ofertaPrincipal.preco_com_desconto
          },
          precoInfo.preco_final_venda
        );

        precoInfo.preco_melhor_oferta = precoFinalOferta;
        precoInfo.desconto_oferta_percentual = ofertaPrincipal.desconto_pct;
        precoInfo.preco_sem_desconto = ofertaPrincipal.preco_normal;
        precoInfo.preco_com_desconto = ofertaPrincipal.preco_com_desconto;
        precoInfo.nome_caderno_oferta = ofertaPrincipal.caderno;
        precoInfo.caderno_oferta_id = ofertaPrincipal.caderno_id;
        precoInfo.tipo_oferta = ofertaPrincipal.tipo_oferta;
        precoInfo.leve = ofertaPrincipal.leve;
        precoInfo.pague = ofertaPrincipal.pague;
        precoInfo.desconto_leve_pague = ofertaPrincipal.desconto_leve_pague;
        precoInfo.preco_final_venda = precoFinalOferta;
        precoInfo.tem_oferta_ativa = true;
        precoInfo.origem_oferta = 'caderno_solicitado';
        precoInfo.ofertas_caderno = ofertas;
      });

      console.log(`[PREÇOS] Caderno solicitado retornou ${ofertasCaderno.rows.length} oferta(s) ativa(s)`);
    }

    console.log(`[PREÇOS] ✅ Encontrados preços para ${Object.keys(precosMap).length} embalagens`);
    const comOferta = Object.values(precosMap).filter(p => p.tem_oferta_ativa).length;
    if (comOferta > 0) {
      console.log(`[PREÇOS] 🎯 ${comOferta} produto(s) com oferta ativa`);
    }

    return precosMap;
  } catch (error) {
    console.error(`[PREÇOS] ⚠️ Erro:`, error.message);
    return {};
  }
}

async function buscarPorDescricao(termoBusca) {
  console.log(`\n[ETAPA 1] Buscando por DESCRIÇÃO: "${termoBusca}"`);

  try {
    const variacoes = expandirAbreviacoes(termoBusca);

    console.log(`[ETAPA 1] 🔍 Variações geradas: ${variacoes.length}`);
    variacoes.forEach((v, idx) => {
      console.log(`         ${idx + 1}. "${v}"`);
    });

    const { condicoes, parametros, relevanciaSQL, orderBy } = gerarCondicoesBuscaComRanking(variacoes);

    const query = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras,
        ${relevanciaSQL} as relevancia_descricao
      FROM produto p
      LEFT JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE (${condicoes})
        AND p.status = 'A'
      ORDER BY ${orderBy}
      LIMIT 100
    `;

    const resultado = await pool.query(query, parametros);

    if (resultado.rows.length > 0) {
      console.log(`[ETAPA 1] ✅ Encontrados ${resultado.rows.length} produtos`);
      console.log(`[ETAPA 1] Top 3 por relevância:`);
      resultado.rows.slice(0, 3).forEach((p, idx) => {
        console.log(`         ${idx + 1}. [${p.relevancia_descricao}pts] ${p.descricao.substring(0, 60)}`);
      });

      return {
        encontrado: true,
        produtos: resultado.rows,
        metodo: 'descricao',
        variacoes_usadas: variacoes
      };
    }

    console.log(`[ETAPA 1] ❌ Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      metodo: 'descricao',
      variacoes_usadas: variacoes
    };
  } catch (error) {
    console.error(`[ETAPA 1] ⚠️ Erro:`, error.message);
    throw error;
  }
}

async function buscarPorPrincipioAtivo(principioAtivo, formaFarmaceutica, variacoesForma) {
  console.log(`\n[ETAPA 2] Buscando por PRINCÍPIO ATIVO: "${principioAtivo}"`);

  try {
    const resultadoPrincipios = await pool.query(`
      SELECT DISTINCT id, nome 
      FROM principioativo 
      WHERE nome ILIKE $1
      ORDER BY nome
    `, [`%${principioAtivo}%`]);

    if (resultadoPrincipios.rows.length === 0) {
      console.log(`[ETAPA 2] ❌ Nenhum princípio ativo encontrado`);
      return {
        encontrado: false,
        produtos: [],
        principiosEncontrados: [],
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] 📋 Encontrados ${resultadoPrincipios.rows.length} princípios ativos`);
    const principiosEncontrados = resultadoPrincipios.rows;

    const principioIds = principiosEncontrados.map(p => p.id);
    const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');

    let queryProdutos = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras
      FROM produto p
      INNER JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE pa.id IN (${principioPlaceholders})
        AND p.status = 'A'
    `;

    let params = [...principioIds];

    if (formaFarmaceutica && variacoesForma.length > 0) {
      const startIdx = principioIds.length + 1;
      const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
      queryProdutos += ` AND (${formaPlaceholders})`;
      params.push(...variacoesForma.map(v => `%${v}%`));
      console.log(`[ETAPA 2] 🔍 Filtrando por formas: ${variacoesForma.join(', ')}`);
    }

    queryProdutos += ` ORDER BY p.descricao LIMIT 100`;

    const resultadoProdutos = await pool.query(queryProdutos, params);

    if (resultadoProdutos.rows.length === 0 && formaFarmaceutica) {
      console.log(`[ETAPA 2] 🔄 Tentando sem filtro de forma...`);

      const querySemForma = `
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome,
          em.id as embalagem_id,
          em.descricao as embalagem_descricao,
          em.codigobarras
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        WHERE pa.id IN (${principioPlaceholders})
          AND p.status = 'A'
        ORDER BY p.descricao
        LIMIT 100
      `;

      const resultadoSemForma = await pool.query(querySemForma, principioIds);

      if (resultadoSemForma.rows.length > 0) {
        console.log(`[ETAPA 2] ✅ Encontrados ${resultadoSemForma.rows.length} produtos (sem forma)`);
        return {
          encontrado: true,
          produtos: resultadoSemForma.rows,
          principiosEncontrados,
          metodo: 'principio_ativo_sem_forma'
        };
      }
    } else if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2] ✅ Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        principiosEncontrados,
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] ❌ Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      principiosEncontrados,
      metodo: 'principio_ativo'
    };
  } catch (error) {
    console.error(`[ETAPA 2] ⚠️ Erro:`, error.message);
    throw error;
  }
}

async function buscarPorPrincipioAtivoIds(principioIds, formaFarmaceutica, variacoesForma) {
  if (!Array.isArray(principioIds) || principioIds.length === 0) {
    return {
      encontrado: false,
      produtos: [],
      metodo: 'principio_ativo_por_ids'
    };
  }

  console.log(`\n[ETAPA 2B] Expandindo por PRINCIPIO ATIVO IDs: ${principioIds.join(', ')}`);

  try {
    const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');
    let queryProdutos = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras
      FROM produto p
      INNER JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE pa.id IN (${principioPlaceholders})
        AND p.status = 'A'
    `;

    let params = [...principioIds];

    if (formaFarmaceutica && variacoesForma.length > 0) {
      const startIdx = principioIds.length + 1;
      const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
      queryProdutos += ` AND (${formaPlaceholders})`;
      params.push(...variacoesForma.map(v => `%${v}%`));
      console.log(`[ETAPA 2B] Filtrando por formas: ${variacoesForma.join(', ')}`);
    }

    queryProdutos += ` ORDER BY p.descricao LIMIT 200`;

    const resultadoProdutos = await pool.query(queryProdutos, params);

    if (resultadoProdutos.rows.length === 0 && formaFarmaceutica) {
      const querySemForma = `
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome,
          em.id as embalagem_id,
          em.descricao as embalagem_descricao,
          em.codigobarras
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        WHERE pa.id IN (${principioPlaceholders})
          AND p.status = 'A'
        ORDER BY p.descricao
        LIMIT 200
      `;

      const resultadoSemForma = await pool.query(querySemForma, principioIds);
      if (resultadoSemForma.rows.length > 0) {
        console.log(`[ETAPA 2B] Encontrados ${resultadoSemForma.rows.length} produtos (sem forma)`);
        return {
          encontrado: true,
          produtos: resultadoSemForma.rows,
          metodo: 'principio_ativo_por_ids_sem_forma'
        };
      }
    } else if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2B] Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        metodo: 'principio_ativo_por_ids'
      };
    }

    return {
      encontrado: false,
      produtos: [],
      metodo: 'principio_ativo_por_ids'
    };
  } catch (error) {
    console.error(`[ETAPA 2B] Erro:`, error.message);
    throw error;
  }
}

async function verificarDisponibilidade(produtos, unidadeNegocioId, cadernoOfertaId = null) {
  console.log(`\n[ETAPA 3] Verificando DISPONIBILIDADE de ${produtos.length} produtos...`);

  if (produtos.length === 0) {
    console.log(`[ETAPA 3] ⚠️ Nenhum produto para verificar`);
    return [];
  }

  try {
    const embalagemIds = produtos.map(p => p.embalagem_id);
    const placeholders = embalagemIds.map((_, idx) => `$${idx + 1}`).join(',');

    const resultado = await pool.query(`
      SELECT 
        embalagemid,
        COALESCE(estoque, 0) as estoque_disponivel
      FROM estoque
      WHERE embalagemid IN (${placeholders})
        AND unidadenegocioid = $${embalagemIds.length + 1}
    `, [...embalagemIds, unidadeNegocioId]);

    const estoqueMap = {};
    resultado.rows.forEach(row => {
      estoqueMap[row.embalagemid] = row.estoque_disponivel;
    });

    const precosMap = await buscarPrecosEOfertas(embalagemIds, unidadeNegocioId, cadernoOfertaId);

    produtos.forEach(produto => {
      produto.estoque_disponivel = estoqueMap[produto.embalagem_id] || 0;
      produto.tem_estoque = (estoqueMap[produto.embalagem_id] || 0) > 0;

      const precoInfo = precosMap[produto.embalagem_id] || {};
      produto.precos = precoInfo;
    });

    const produtosComEstoque = produtos.filter(p => p.tem_estoque);
    const produtosSemEstoque = produtos.filter(p => !p.tem_estoque);

    console.log(`[ETAPA 3] ✅ ${produtosComEstoque.length} com estoque | ❌ ${produtosSemEstoque.length} sem estoque`);

    return produtosComEstoque;
  } catch (error) {
    console.error(`[ETAPA 3] ⚠️ Erro:`, error.message);
    throw error;
  }
}

module.exports = {
  buscarPrecosEOfertas,
  buscarPorDescricao,
  buscarPorPrincipioAtivo,
  buscarPorPrincipioAtivoIds,
  verificarDisponibilidade
};
