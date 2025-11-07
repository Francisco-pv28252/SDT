import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify()
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const activePeers = new Set()
const confirmations = new Map() // version -> Map(peerId, hash)
const savedVector = []          // vetor principal de CIDs confirmados
let currentVersion = 1
let embedder

await server.register(import("@fastify/multipart"))

// -------------------------
// Utilitários
// -------------------------
function hashVector(vetor) {
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

      if (data.action === "hello" && data.peerId) {
        activePeers.add(data.peerId)
        console.log(`👋 Peer conectado: ${data.peerId}`)
        return
      }

      if (data.action === "ack") {
        if (!confirmations.has(data.version))
          confirmations.set(data.version, new Map())
        confirmations.get(data.version).set(data.peerId, data.hash)
        console.log(`ACK recebido de ${data.peerId} para versão ${data.version}`)
        return
      }

      if (data.action === "commit") {
        console.log(`Commit recebido de ${data.peerId} (ignorado, líder é quem confirma)`)
        return
      }

    } catch (err) {
      console.log("Mensagem inválida:", mensagem)
    }
  })

  console.log(`✅ Subscrito ao tópico ${TOPIC}`)
}

// -------------------------
// API: Upload de ficheiros
// -------------------------
server.post("/files", async (req, res) => {
  try {
    const file = await req.file()
    if (!file) return res.code(400).send({ error: "Nenhum ficheiro enviado" })

    const fileBuffer = await file.toBuffer()
    const filename = file.filename || "unnamed"
    const nextVersion = currentVersion + 1

    const peers = Array.from(activePeers)
    if (peers.length === 0)
      return res.code(503).send({ error: "Nenhum peer conectado" })

    console.log(`\n📢 Nova proposta: versão ${nextVersion} (${filename})`)

    // Cria proposta com o vetor atual
    const proposta = { action: "propose", version: nextVersion, peerId: "leader", saveddata: savedVector }
    await publish(proposta)

    confirmations.set(nextVersion, new Map())

    // Esperar confirmações
    const TIMEOUT_MS = 20000
    const waitForAllPeers = () =>
      new Promise((resolve) => {
        const start = Date.now()
        const check = () => {
          const confirmed = confirmations.get(nextVersion)
          if (
            confirmed &&
            peers.every(p => confirmed.has(p)) &&
            new Set([...confirmed.values()]).size === 1
          ) return resolve(true)
          if (Date.now() - start > TIMEOUT_MS) return resolve(false)
          setTimeout(check, 400)
        }
        check()
      })

    const allConfirmed = await waitForAllPeers()
    if (!allConfirmed)
      return res.code(409).send({ error: "Nem todos os peers confirmaram a proposta." })

    console.log("✅ Todos os peers confirmaram a versão proposta.")

    // Adiciona ficheiro ao IPFS
    const added = await ipfs.add({ path: filename, content: fileBuffer })
    const cid = added.cid.toString()
    console.log(`🗃️ Ficheiro adicionado ao IPFS: ${cid}`)

    // Gera embedding opcional
    let embedding = null
    if (embedder) {
      let text = fileBuffer.toString("utf-8").replace(/\0/g, "").slice(0, 1000)
      const output = await embedder(text, { pooling: "mean", normalize: true })
      embedding = Array.from(output.data)
    }

    // Atualiza vetor
    savedVector.push({ cid })
    currentVersion = nextVersion

    // Envia commit final
    const commitMsg = { action: "commit", version: currentVersion, cid, peerId: "leader", embedding }
    await publish(commitMsg)
    console.log(`📦 Commit enviado (versão ${currentVersion}, CID=${cid})`)

    confirmations.delete(currentVersion)

    return { status: "Commit enviado", version: currentVersion, cid }
  } catch (err) {
    console.error("❌ Erro no endpoint /files:", err)
    return res.code(500).send({ error: "Erro ao processar ficheiro" })
  }
})

// -------------------------
// API: Listar peers conectados
// -------------------------
server.get("/peers", async () => ({ peers: Array.from(activePeers) }))

// -------------------------
// Inicialização do servidor
// -------------------------
server.listen({ port: 5323 }, async () => {
  console.log("🚀 Servidor (líder) a correr na porta 5323")
  console.log("A carregar modelo de embeddings...")
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  console.log("Modelo de embeddings carregado ✅")

  await subscribeToMessages()

  const id = await ipfs.id().catch(() => ({ id: "leader-local" }))
  const helloMsg = { action: "hello", peerId: id.id }
  await publish(helloMsg)
  console.log(`Presença do líder anunciada: ${id.id}`)
})
