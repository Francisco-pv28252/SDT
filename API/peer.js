import fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = fastify()
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"
const tempVectors = new Map()
const savedVector = []
let currentVersion = 0
let peerId = null
let embedder

function hashVector(vetor) {
  return vetor.map(x => x.cid || x.filename || "").join("|").split("")
    .reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
}

async function subscribe() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data)
    try {
      const data = JSON.parse(mensagem)
      if (data.peerId === peerId) return

      if (data.action === "hello") {
        console.log(`Peer detectado: ${data.peerId}`)
        return
      }

      if (data.action === "propose") {
        console.log(`Proposta recebida v${data.version} de ${data.peerId}`)
        const proposedVector = Array.isArray(data.saveddata) ? data.saveddata : []
        console.log(`Vetor recebido v${data.version}:`, proposedVector)
        tempVectors.set(data.version, proposedVector)
        const hash = hashVector(proposedVector)
        const ack = { action: "ack", version: data.version, peerId, hash }
        await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(ack), "utf-8"))
        console.log(`ACK enviado v${data.version} hash=${hash}`)
        return
      }

      if (data.action === "commit") {
        if (data.version <= currentVersion) return
        console.log(`Commit recebido v${data.version}`)
        const vetor = Array.isArray(data.vector) ? data.vector : []
        savedVector.length = 0
        savedVector.push(...vetor)
        console.log(`Vetor final recebido v${data.version}:`, savedVector)
        currentVersion = data.version
        console.log(`Vetor final atualizado v${currentVersion}:`, savedVector)
        tempVectors.delete(data.version)
        return
      }

    } catch (e) {
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
  const id = await ipfs.id().catch(() => ({ id: "peer-local" }))
  peerId = id.id
  await subscribe()
  const helloMsg = { action: "hello", peerId }
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(helloMsg), "utf-8"))
  console.log(`Presença anunciada: ${peerId}`)
})
