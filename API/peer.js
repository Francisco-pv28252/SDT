import Fastify from "fastify"
import { create } from "ipfs-http-client"

const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const server = Fastify()
const peersAtivos = new Set()
const TOPICO = "mensagens-sistema"

async function getSafePeerId() {
  try {
    const id = await ipfs.id()
    return id.id
  } catch {
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

async function getConnectedPeers() {
  const peers = await ipfs.swarm.peers()
  const locais = peers
    .filter(p => p.addr.toString().includes("127.0.0.1") || p.addr.toString().includes("192.168.") || p.addr.toString().includes("/ip4/10."))
    .map(p => p.peer.toString())
  console.log(`Peers locais conectados: ${locais.join(", ") || "(nenhum)"}`)
  return locais
}

await subscrever()
await anunciarPresenca()
await getConnectedPeers()

server.get("/peers", async () => ({ peers: Array.from(peersAtivos) }))
server.listen({ port: 5324 })
