import Fastify from "fastify"
import { create } from "ipfs-http-client"
import { pipeline } from "@xenova/transformers"

const server = Fastify()
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const currentVector = []            
const tempVectors = new Map()       
const tempEmbeddings = new Map()    
let currentVersion = 1
let peerId
let embedder


function hashVector(vector) {
  return vector.map(x => x.cid).join("|").split("")
    .reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
}

async function subscribe() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder().decode(msg.data)
    try {
      const data = JSON.parse(mensagem)

      if (data.peerId === peerId) return

      if (data.action === "propose") {
        console.log(`Proposta recebida: versão=${data.version}`)

        if (data.version <= currentVersion) {
          console.log("⚠️ Versão conflitante ou desatualizada. Ignorada.")
          return
        }

        const newVector = [...data.saveddata]
        tempVectors.set(data.version, newVector)

        const hash = hashVector(newVector)

        const ack = { action: "ack", version: data.version, peerId, hash }
        await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(ack), "utf-8"))
        console.log(`ACK enviado para versão ${data.version} com hash ${hash}`)
      }

      else if (data.action === "commit") {
        const version = data.version
        if (!tempVectors.has(version)) {
          console.log("⚠️ Commit ignorado: versão desconhecida.")
          return
        }

        const committedVector = tempVectors.get(version)
        currentVersion = version
        currentVector.splice(0, currentVector.length, ...committedVector)
        tempVectors.delete(version)

        if (data.embedding) {
          tempEmbeddings.set(version, data.embedding)
          console.log(`Embedding armazenado para versão ${version}`)
        }

        console.log(`✅ Versão ${version} confirmada com CID ${data.cid}`)
      }

      else if (data.action === "hello" && data.peerId) {
        console.log(`Peer detectado: ${data.peerId}`)
      }

    } catch (err) {
      console.error("Mensagem inválida:", mensagem)
    }
  })

  console.log(`Subscrito ao tópico ${TOPIC}`)
}


server.listen({ port: 5330 }, async () => {
  console.log("Peer em execução na porta 5330")

  console.log("A carregar modelo de embeddings...")
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  console.log("Modelo de embeddings carregado")

  const id = await ipfs.id().catch(() => ({ id: "peer-local" }))
  peerId = id.id

  await subscribe()

  const helloMsg = { action: "hello", peerId }
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(helloMsg), "utf-8"))
  console.log(`Presença anunciada: ${peerId}`)
})
