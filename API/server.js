// server.js (líder) - commit por MAIORIA
import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify({ logger: false })
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const activePeers = new Set()               // peers que anunciaram "hello"
const confirmations = new Map()             // version -> Map(peerId -> hash)
const savedVector = []                      // vetor de CIDs confirmados (histórico simples)
let currentVersion = 0                      // versão actual confirmada (começa em 0)
let embedder = null

await server.register(import("@fastify/multipart"))

// -------------------------
// Utilitários
// -------------------------
function hashVector(vetor) {
  // função determinística simples para gerar um "hash" do vetor
  return vetor.map(x => x.cid).join("|").split("")
    .reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
}

async function publish(msg) {
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(msg), "utf-8"))
}

// -------------------------
// Subscrição a mensagens PubSub
// -------------------------
async function subscribeToMessages() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data)
    try {
      const data = JSON.parse(mensagem)

      // hello - adiciona peer à lista de activos
      if (data.action === "hello" && data.peerId) {
        activePeers.add(data.peerId)
        console.log(`👋 Peer conectado: ${data.peerId}  | peers totais = ${activePeers.size}`)
        return
      }

      // ack - armazenar confirmação
      if (data.action === "ack" && data.version && data.peerId) {
        if (!confirmations.has(data.version))
          confirmations.set(data.version, new Map())
        confirmations.get(data.version).set(data.peerId, data.hash)
        console.log(`ACK recebido de ${data.peerId} para versão ${data.version} -> hash=${data.hash}`)
        return
      }

      // commit (outros) - líder ignora commits vindos de peers
      if (data.action === "commit") {
        console.log(`Commit recebido (ignorado pelo líder): versão=${data.version}, cid=${data.cid}`)
        return
      }

    } catch (err) {
      console.log("Mensagem inválida no tópico:", mensagem)
    }
  })

  console.log(`✅ Subscrito ao tópico ${TOPIC}`)
}

// -------------------------
// Espera por peers (opcional)
// -------------------------
async function waitForMinPeers(minPeers = 1, maxWaitMs = 15000) {
  // espera até haver pelo menos minPeers ou até maxWaitMs expirar
  const start = Date.now()
  while (activePeers.size < minPeers) {
    if (Date.now() - start > maxWaitMs) {
      console.log(`⏱️ Tempo de espera por peers esgotado (${maxWaitMs}ms). peers=${activePeers.size}`)
      return false
    }
    console.log(`⏳ À espera de pelo menos ${minPeers} peer(s)... atualmente: ${activePeers.size}`)
    await new Promise(r => setTimeout(r, 500))
  }
  console.log(`✅ Temos pelo menos ${minPeers} peer(s) conectados.`)
  return true
}

// -------------------------
// Lógica de maioria
// -------------------------
function requiredMajority(nPeers) {
  if (nPeers <= 1) return 1
  return Math.ceil(nPeers / 2)
}

async function waitForMajority(version, timeoutMs = 20000) {
  const start = Date.now()
  const peersSnapshot = Array.from(activePeers)
  const required = requiredMajority(peersSnapshot.length)

  console.log(`🔎 Aguardando maioria para versão ${version}. Peers snapshot=${peersSnapshot.length}, required=${required}`)

  return new Promise((resolve) => {
    const check = () => {
      const confirmed = confirmations.get(version)
      const now = Date.now()

      if (confirmed) {
        // quantos peers confirmaram até agora (do snapshot)
        const confirmedCount = peersSnapshot.filter(p => confirmed.has(p)).length

        // se atingimos o número necessário, verificar se todos os hashes recebidos são idênticos
        if (confirmedCount >= required) {
          const hashes = peersSnapshot
            .filter(p => confirmed.has(p))
            .map(p => confirmed.get(p))
          const uniqueHashes = new Set(hashes)

          if (uniqueHashes.size === 1) {
            console.log(`✅ Maioria atingida para versão ${version} (confirmed=${confirmedCount}/${peersSnapshot.length}) hash=${[...uniqueHashes][0]}`)
            return resolve({ ok: true, hash: [...uniqueHashes][0], confirmedCount })
          } else {
            console.log(`⚠️ Hashes divergentes entre confirmações para versão ${version}:`, Array.from(confirmed.entries()))
            // Não resolvemos para true; espera até timeout ou harmonização (poderias desejar resolver como false aqui)
          }
        } else {
          // ainda sem maioria
          //console.log(`Ainda: ${confirmedCount}/${required} confirmações...`)
        }
      }

      if (now - start > timeoutMs) {
        const confirmedCount = confirmations.get(version) ? confirmations.get(version).size : 0
        console.log(`⏳ Timeout (${timeoutMs}ms) à espera da maioria para versão ${version}. Confirmados=${confirmedCount}`)
        return resolve({ ok: false, reason: "timeout", confirmedCount })
      }

      setTimeout(check, 300)
    }

    check()
  })
}

// -------------------------
// Endpoint: upload de ficheiros (coordenação)
// -------------------------
server.post("/files", async (req, res) => {
  try {
    const file = await req.file()
    if (!file) return res.code(400).send({ error: "Nenhum ficheiro enviado" })

    const fileBuffer = await file.toBuffer()
    const filename = file.filename || "unnamed"
    const nextVersion = currentVersion + 1

    const peers = Array.from(activePeers)
    if (peers.length === 0) {
      // podes forçar o envio mesmo sem peers, mas aqui devolvemos erro
      return res.code(503).send({ error: "Nenhum peer conectado" })
    }

    console.log(`\n📢 Nova proposta: versão ${nextVersion} (${filename})`)
    // publica a proposta com o vetor actual (savedVector)
    const proposta = {
      action: "propose",
      version: nextVersion,
      peerId: "leader",
      saveddata: savedVector
    }
    await publish(proposta)

    // prepara o mapa de confirmações para esta versão
    confirmations.set(nextVersion, new Map())

    // espera pela maioria
    const TIMEOUT_MS = 20000
    const result = await waitForMajority(nextVersion, TIMEOUT_MS)

    if (!result.ok) {
      // falha por timeout ou divergência
      confirmations.delete(nextVersion)
      return res.code(409).send({ error: "Não foi possível obter maioria de ACKs idênticos", details: result })
    }

    // todos concordaram com o mesmo hash: avançar com o commit
    // adiciona o ficheiro ao IPFS
    const added = await ipfs.add({ path: filename, content: fileBuffer })
    const cid = added.cid.toString()
    console.log(`🗃️ Ficheiro adicionado ao IPFS: ${cid}`)

    // gera embedding opcional
    let embedding = null
    if (embedder) {
      try {
        let text = fileBuffer.toString("utf-8").replace(/\0/g, "").slice(0, 1000)
        const output = await embedder(text, { pooling: "mean", normalize: true })
        embedding = Array.from(output.data)
      } catch (e) {
        console.warn("⚠️ Erro ao gerar embedding (ignorando):", e.message || e)
      }
    }

    // actualiza vetor confirmado
    savedVector.push({ version: nextVersion, cid })
    currentVersion = nextVersion

    // envia commit final para todos os peers
    const commitMsg = { action: "commit", version: currentVersion, cid, peerId: "leader", embedding }
    await publish(commitMsg)
    console.log(`📦 Commit publicado: versão=${currentVersion}, cid=${cid}`)

    // limpezas
    confirmations.delete(nextVersion)

    return { status: "Commit enviado", version: currentVersion, cid }
  } catch (err) {
    console.error("❌ Erro no endpoint /files:", err)
    return res.code(500).send({ error: "Erro ao processar ficheiro", details: err.message })
  }
})

// -------------------------
// Endpoint: listar peers conectados
// -------------------------
server.get("/peers", async () => ({ peers: Array.from(activePeers) }))

// -------------------------
// Inicialização do servidor
// -------------------------
server.listen({ port: 5323 }, async () => {
  console.log("🚀 Servidor (líder) a correr na porta 5323")
  console.log("A carregar modelo de embeddings...")
  try {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
    console.log("Modelo de embeddings carregado ✅")
  } catch (e) {
    console.warn("⚠️ Não foi possível carregar modelo de embeddings (seguir sem embeddings).", e.message || e)
    embedder = null
  }

  await subscribeToMessages()

  // publica hello para que os peers saibam quem é o líder
  try {
    const id = await ipfs.id().catch(() => ({ id: "leader-local" }))
    const helloMsg = { action: "hello", peerId: id.id }
    await publish(helloMsg)
    console.log(`Presença do líder anunciada: ${id.id}`)
  } catch (e) {
    console.warn("⚠️ Não foi possível publicar hello:", e.message || e)
  }
})
