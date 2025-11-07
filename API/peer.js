import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify()
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const tempVectors = new Map()
const tempEmbeddings = new Map()
const savedVector = []
const localEmbeddings = []
let currentVersion = 0
let peerId = null
let embedder

function hashVector(vetor) {
  return vetor.map(x => x.cid).join("|").split("")
    .reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
}

async function subscribe() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data)
    try {
      const data = JSON.parse(mensagem)

      if (data.action === "hello" && data.peerId) {
        console.log(`Peer detectado: ${data.peerId}`)
        return
      }

      if (data.action === "propose") {
        console.log(`Proposta recebida: versão=${data.version} do peer ${data.peerId || 'líder'}`)
        if (data.version <= currentVersion) {
          console.log(`Versão ${data.version} ≤ currentVersion (${currentVersion}) — ignorada.`)
          return
        }
        const proposedVector = Array.isArray(data.saveddata) ? data.saveddata : []
        tempVectors.set(data.version, proposedVector)
        const hash = hashVector(proposedVector)
        if (data.embedding) tempEmbeddings.set(data.version, data.embedding)
        const ack = { action: "ack", version: data.version, peerId, hash }
        await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(ack), "utf-8"))
        console.log(`ACK enviado para versão ${data.version} com hash ${hash}`)
        return
      }

      if (data.action === "commit") {
        if (data.version <= currentVersion) return
        console.log(`Commit recebido: versão=${data.version}`)
        const vetor = tempVectors.get(data.version) || []
        savedVector.length = 0
        savedVector.push(...vetor)
        currentVersion = data.version
        if (data.embedding)
          localEmbeddings.push({ version: currentVersion, cid: data.cid, embedding: data.embedding })
        tempVectors.delete(data.version)
        tempEmbeddings.delete(data.version)
        console.log(`Versão ${currentVersion} confirmada.`)
        return
      }

    } catch {
      console.log("Mensagem inválida:", mensagem)
    }
  })
  console.log(`Subscrito ao tópico ${TOPIC}`)
}

server.get("/version", async () => ({ version: currentVersion }))
server.get("/vector", async () => ({ vector: savedVector }))
server.listen({ port: 5325 }, async () => {
  console.log("Peer ativo na porta 5325")
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  console.log("Modelo de embeddings carregado")

  const id = await ipfs.id().catch(() => ({ id: "peer-local" }))
  peerId = id.id

  await subscribe()
  
  const helloMsg = { action: "hello", peerId }
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(helloMsg), "utf-8"))
  console.log(`Presença anunciada: ${peerId}`)
})
