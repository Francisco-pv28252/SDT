import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify({ logger: false })
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const activePeers = new Set()
const confirmations = new Map()
let savedVector = []
let currentVersion = 0
let embedder = null

await server.register(import("@fastify/multipart"))

function hashVector(vetor) {
  return vetor.map(x => x.cid).join("|").split("").reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
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
        console.log(`Peer conectado: ${data.peerId}  | total=${activePeers.size}`)
        return
      }

      if (data.action === "ack" && data.version && data.peerId) {
        if (!confirmations.has(data.version))
          confirmations.set(data.version, new Map())
        confirmations.get(data.version).set(data.peerId, data.hash)
        console.log(`ACK recebido de ${data.peerId} para versão ${data.version} hash=${data.hash}`)
        return
      }

      if (data.action === "commit") {
        console.log(`Commit recebido (ignorando pelo líder): versão=${data.version}, cid=${data.cid}`)
        return
      }

    } catch (err) {
      console.log("Mensagem inválida:", mensagem)
    }
  })
}

function requiredMajority(nPeers) {
  if (nPeers <= 1) return 1
  return Math.ceil(nPeers / 2)
}

async function waitForMajority(version, timeoutMs = 20000) {
  const start = Date.now()
  const peersSnapshot = Array.from(activePeers)
  const required = requiredMajority(peersSnapshot.length)
  return new Promise((resolve) => {
    const check = () => {
      const confirmed = confirmations.get(version)
      const now = Date.now()
      if (confirmed) {
        const confirmedCount = peersSnapshot.filter(p => confirmed.has(p)).length
        if (confirmedCount >= required) {
          const hashes = peersSnapshot.filter(p => confirmed.has(p)).map(p => confirmed.get(p))
          if (new Set(hashes).size === 1) {
            return resolve({ ok: true, hash: [...new Set(hashes)][0], confirmedCount })
          }
        }
      }
      if (now - start > timeoutMs) {
        const confirmedCount = confirmations.get(version) ? confirmations.get(version).size : 0
        return resolve({ ok: false, reason: "timeout", confirmedCount })
      }
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
    if (activePeers.size === 0)
      return res.code(503).send({ error: "Nenhum peer conectado" })

    console.log(`Nova proposta: versão ${nextVersion} (${filename})`)
    const proposta = { action: "propose", version: nextVersion, peerId: "leader", vector: savedVector }
    await publish(proposta)

    confirmations.set(nextVersion, new Map())
    const result = await waitForMajority(nextVersion, 20000)
    if (!result.ok) {
      confirmations.delete(nextVersion)
      return res.code(409).send({ error: "Não foi possível obter maioria", details: result })
    }

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

    const commitMsg = { action: "commit", version: currentVersion, vector: savedVector, cid, peerId: "leader", embedding }
    await publish(commitMsg)
    console.log(`Commit publicado: versão=${currentVersion}, vetor=${JSON.stringify(savedVector)}`)
    confirmations.delete(nextVersion)
    return { status: "Commit enviado", version: currentVersion, cid }

  } catch (err) {
    return res.code(500).send({ error: "Erro ao processar ficheiro", details: err.message })
  }
})

server.get("/peers", async () => ({ peers: Array.from(activePeers) }))

server.listen({ port: 5323 }, async () => {
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2").catch(() => null)
  await subscribeToMessages()
  const id = await ipfs.id().catch(() => ({ id: "leader-local" }))
  await publish({ action: "hello", peerId: id.id })
  console.log(`Servidor líder a correr na porta 5323, peerId=${id.id}`)
})
