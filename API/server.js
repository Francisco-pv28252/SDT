import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify()
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const saveddata = []
const prevsaveddata = []
const localEmbeddings = []
const confirmations = new Map()
const activePeers = new Set()

let embedder
let v = 1

await server.register(import("@fastify/multipart"))

function hashVector(vetor) {
  return vetor.map(x => x.cid).join("|").split("")
    .reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
}

async function subscribeToMessages() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data)
    try {
      const data = JSON.parse(mensagem)

      if (data.action === "hello" && data.peerId) {
        activePeers.add(data.peerId)
        console.log(`Peer conectado: ${data.peerId}`)
        return
      }

      if (data.action === "ack") {
        if (!confirmations.has(data.version))
          confirmations.set(data.version, new Map())
        confirmations.get(data.version).set(data.peerId, data.hash)
        return
      }

      if (data.action === "commit") {
        console.log(`Commit recebido: versão=${data.version}, cid=${data.cid}`)
        return
      }

    } catch {
      console.log("Mensagem inválida:", mensagem)
    }
  })

  console.log(`Subscrito ao tópico ${TOPIC}`)
}

server.post("/files", async (req, res) => {
  try {
    const file = await req.file()
    if (!file) return res.code(400).send({ error: "Nenhum ficheiro enviado" })

    const fileBuffer = await file.toBuffer()
    const filename = file.filename || "unnamed"
    const candidateVersion = v + 1

    const REQUIRED_PEERS = Array.from(activePeers)
    if (REQUIRED_PEERS.length === 0)
      return res.code(503).send({ error: "Nenhum peer conectado" })

    const proposta = { action: "propose", version: candidateVersion, saveddata }
    await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(proposta), "utf-8"))

    confirmations.set(candidateVersion, new Map())

    const TIMEOUT_MS = 20000
    const waitForAllPeers = () =>
      new Promise((resolve) => {
        const start = Date.now()
        const check = () => {
          const confirmed = confirmations.get(candidateVersion)
          if (
            confirmed &&
            REQUIRED_PEERS.every(p => confirmed.has(p)) &&
            new Set([...confirmed.values()]).size === 1
          ) return resolve(true)
          if (Date.now() - start > TIMEOUT_MS) return resolve(false)
          setTimeout(check, 300)
        }
        check()
      })

    const todosConfirmaram = await waitForAllPeers()
    if (!todosConfirmaram)
      return res.code(409).send({ error: "Nem todos os peers confirmaram a nova versão." })

    const meta = { path: filename, content: fileBuffer }
    const response = await ipfs.add(meta)
    const cid = response.cid.toString()

    let vector = null
    if (embedder) {
      let text = fileBuffer.toString("utf-8").replace(/\0/g, "").slice(0, 1000)
      const output = await embedder(text, { pooling: "mean", normalize: true })
      vector = Array.from(output.data)
    }

    prevsaveddata.push([...saveddata])
    if (saveddata.length === 0 || !saveddata[0].version)
      saveddata.unshift({ version: candidateVersion })
    else
      saveddata[0].version = candidateVersion

    saveddata.push({ cid })
    localEmbeddings.push({ version: candidateVersion, cid, embedding: vector })

    const commitMsg = { action: "commit", version: candidateVersion, cid, embedding: vector, saveddata }
    await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(commitMsg), "utf-8"))

    confirmations.delete(candidateVersion)
    v = candidateVersion

    return { status: "Commit enviado", version: v, cid }
  } catch (err) {
    console.error("Erro no endpoint /files:", err)
    return res.code(500).send({ error: "Erro ao processar ficheiro" })
  }
})

server.get("/peers", async () => ({ peers: Array.from(activePeers) }))

server.listen({ port: 5323 }, async () => {
  console.log("Servidor a correr na porta 5323")
  console.log("A carregar modelo de embeddings...")
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  console.log("Modelo de embeddings carregado")
  await subscribeToMessages()

  const id = await ipfs.id().catch(() => ({ id: "local-peer" }))
  const helloMsg = { action: "hello", peerId: id.id }
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(helloMsg), "utf-8"))
  console.log(`Presença do servidor anunciada: ${id.id}`)
})
