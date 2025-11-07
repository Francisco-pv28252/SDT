import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify({ logger: false })
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const activePeers = new Set()
const confirmations = new Map()
const savedVector = []
let currentVersion = 0
let embedder = null

await server.register(import("@fastify/multipart"))

function hashVector(vetor) {
  return vetor.map(x => x.cid || x.filename || "").join("|").split("")
    .reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
}

async function publish(msg) {
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(msg), "utf-8"))
}

async function subscribeToMessages() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data)
    try {
      const data = JSON.parse(mensagem)
      if (data.action === "hello" && data.peerId) {
        activePeers.add(data.peerId)
        console.log(`Peer conectado: ${data.peerId} | total=${activePeers.size}`)
        return
      }
      if (data.action === "ack" && data.version && data.peerId) {
        if (!confirmations.has(data.version)) confirmations.set(data.version, new Map())
        confirmations.get(data.version).set(data.peerId, data.hash)
        console.log(`ACK de ${data.peerId} para versão ${data.version} -> hash=${data.hash}`)
        return
      }
    } catch (err) {
      console.log("Mensagem inválida:", mensagem)
    }
  })
  console.log(`Subscrito ao tópico ${TOPIC}`)
}

function requiredMajority(n) {
  if (n <= 1) return 1
  return Math.ceil(n / 2)
}

async function waitForMajority(version, timeoutMs = 20000) {
  const start = Date.now()
  const peersSnapshot = Array.from(activePeers)
  const required = requiredMajority(peersSnapshot.length)
  console.log(`Aguardando maioria para versão ${version} (peers=${peersSnapshot.length}, req=${required})`)
  return new Promise((resolve) => {
    const check = () => {
      const conf = confirmations.get(version)
      const now = Date.now()
      if (conf) {
        const confirmedCount = peersSnapshot.filter(p => conf.has(p)).length
        if (confirmedCount >= required) {
          const hashes = peersSnapshot.filter(p => conf.has(p)).map(p => conf.get(p))
          const unique = new Set(hashes)
          if (unique.size === 1) {
            console.log(`Maioria atingida v${version} (${confirmedCount}/${peersSnapshot.length}) hash=${[...unique][0]}`)
            return resolve({ ok: true })
          }
        }
      }
      if (now - start > timeoutMs) return resolve({ ok: false })
      setTimeout(check, 300)
    }
    check()
  })
}

server.post("/files", async (req, res) => {
  try {
    const file = await req.file()
    if (!file) return res.code(400).send({ error: "Nenhum ficheiro enviado" })
    const fileBuffer = await file.toBuffer()
    const filename = file.filename || "unnamed"
    const nextVersion = currentVersion + 1
    const peers = Array.from(activePeers)
    if (peers.length === 0) return res.code(503).send({ error: "Nenhum peer conectado" })

    const tempVector = [...savedVector, { version: nextVersion, filename }]
    console.log(`Nova proposta v${nextVersion}:`, tempVector)
    const proposta = { action: "propose", version: nextVersion, peerId: "leader", saveddata: tempVector }
    await publish(proposta)
    confirmations.set(nextVersion, new Map())
    const result = await waitForMajority(nextVersion, 20000)
    if (!result.ok) return res.code(409).send({ error: "Sem maioria de ACKs" })

    const added = await ipfs.add({ path: filename, content: fileBuffer })
    const cid = added.cid.toString()
    console.log(`Ficheiro adicionado ao IPFS: ${cid}`)

    let embedding = null
    if (embedder) {
      try {
        let text = fileBuffer.toString("utf-8").replace(/\0/g, "").slice(0, 1000)
        const output = await embedder(text, { pooling: "mean", normalize: true })
        embedding = Array.from(output.data)
      } catch {}
    }

    savedVector.push({ version: nextVersion, cid })
    currentVersion = nextVersion
    console.log(`Vetor final confirmado v${currentVersion}:`, savedVector)
    const commitMsg = { action: "commit", version: currentVersion, cid, peerId: "leader", embedding }
    await publish(commitMsg)
    confirmations.delete(nextVersion)
    return { status: "Commit enviado", version: currentVersion, cid }
  } catch (err) {
    console.error("Erro em /files:", err)
    return res.code(500).send({ error: err.message })
  }
})

server.get("/peers", async () => ({ peers: Array.from(activePeers) }))

server.listen({ port: 5323 }, async () => {
  console.log("Servidor líder na porta 5323")
  try {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  } catch {
    embedder = null
  }
  await subscribeToMessages()
  const id = await ipfs.id().catch(() => ({ id: "leader-local" }))
  const helloMsg = { action: "hello", peerId: id.id }
  await publish(helloMsg)
  console.log(`Presença anunciada: ${id.id}`)
})
