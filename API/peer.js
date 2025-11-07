import Fastify from "fastify"
import { create } from "ipfs-http-client"
import fetch from "node-fetch"

const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const server = Fastify()
const peersAtivos = new Set()
const TOPICO = "mensagens-sistema"

async function getSafePeerId() {
  try {
    const res = await fetch("http://localhost:5001/api/v0/id")
    const data = await res.json()
    return data.ID
  } catch (err) {
    console.error("Erro ao obter PeerID:", err)
    return "unknown-peer"
  }
}

async function anunciarPresenca() {
  const peerId = await getSafePeerId()
  const msg = JSON.stringify({ action: "hello", peerId })
  await ipfs.pubsub.publish(TOPICO, new TextEncoder().encode(msg))
  console.log(`Presença anunciada: ${peerId}`)
}

async function subscrever() {
  await ipfs.pubsub.subscribe(TOPICO, msg => {
    const data = JSON.parse(new TextDecoder().decode(msg.data))
    if (data.action === "hello" && data.peerId) {
      peersAtivos.add(data.peerId)
      mostrarPeers()
    }
  })
  console.log(`Subscrito ao tópico "${TOPICO}"`)
}

function mostrarPeers() {
  console.log("Peers ativos:", Array.from(peersAtivos).join(", ") || "(nenhum)")
}

await subscrever()
await anunciarPresenca()

server.get("/peers", async () => ({ peers: Array.from(peersAtivos) }))
server.listen({ port: 5324 })
