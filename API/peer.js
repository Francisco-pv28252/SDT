import Fastify from "fastify"
import { create } from "ipfs-http-client"

const app = Fastify()
const TOPICO = "mensagens-sistema"
const peersAtivos = new Set()

// Ligação ao daemon local do IPFS
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })

async function getSafePeerId() {
  try {
    const info = await ipfs.id()
    // Filtra endereços com protocolos desconhecidos (ex: webrtc-direct)
    info.addresses = info.addresses?.filter(a => !a.includes("webrtc-direct")) || []
    return info.id
  } catch (err) {
    console.warn("⚠️  Erro ao obter peerId. A usar ID temporário.", err.message)
    return `peer-temp-${Math.random().toString(36).substring(2, 8)}`
  }
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
  console.log(`✅ Subscrito ao tópico "${TOPICO}"`)
}

function mostrarPeers() {
  console.log("🔗 Peers ativos:", Array.from(peersAtivos).join(", ") || "(nenhum)")
}

await subscrever()
await anunciarPresenca()