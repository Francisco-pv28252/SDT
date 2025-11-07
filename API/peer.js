import Fastify from "fastify"
import { create } from "ipfs-http-client"

const app = Fastify()
const TOPICO = "mensagens-sistema"
const peersAtivos = new Set()

const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })

async function getConnectedPeers() {
  const peers = await ipfs.swarm.peers()
  const locais = peers
    .filter(p => p.addr.toString().includes("127.0.0.1") || p.addr.toString().includes("192.168.") || p.addr.toString().includes("/ip4/10."))
    .map(p => p.peer.toString())
  console.log(`Peers locais conectados: ${locais.join(", ") || "(nenhum)"}`)
  return locais
}


async function anunciarPresenca() {
  const peerId = await getSafePeerId()
  const msg = JSON.stringify({ action: "hello", peerId })
  await ipfs.pubsub.publish(TOPICO, new TextEncoder().encode(msg))
  console.log(`📡 Presença anunciada: ${peerId}`)
}

async function subscrever() {
  await ipfs.pubsub.subscribe(TOPICO, msg => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.data))
      if (data.action === "hello" && data.peerId) {
        peersAtivos.add(data.peerId)
        mostrarPeers()
      }
    } catch {
      console.log("Mensagem recebida inválida no pubsub.")
    }
  })
  console.log(`Subscrito ao tópico "${TOPICO}"`)
}

function mostrarPeers() {
  console.log("Peers ativos:", Array.from(peersAtivos).join(", ") || "(nenhum)")
}

await subscrever()
await anunciarPresenca()