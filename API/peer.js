import { create } from "ipfs-http-client"

const ipfs = create({ host: "localhost", port: 5001, protocol: "http" })
const TOPIC = "mensagens-sistema"

const peerId = `peer-${Math.floor(Math.random() * 1000)}`
let localVector = []
let tempVector = []

async function publish(msg) {
  await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(msg), "utf-8"))
}

async function subscribe() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const data = JSON.parse(new TextDecoder("utf-8").decode(msg.data))
    if (data.action === "hello") return
    if (data.action === "propose") {
      console.log(`Recebida proposta versão ${data.version}, vetor=${JSON.stringify(data.vector)}`)
      if (data.version <= localVector.length) {
        console.log("Conflito de versão, ignorando")
        return
      }
      tempVector = [...data.vector]
      const hash = tempVector.map(x => x.cid).join("|").split("").reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0)
      await publish({ action: "ack", version: data.version, peerId, hash })
      console.log(`ACK enviado para versão ${data.version}, hash=${hash}`)
    }
    if (data.action === "commit" && data.version > localVector.length) {
      localVector = data.vector
      tempVector = []
      console.log(`Commit recebido: versão ${data.version}, vetor atualizado=${JSON.stringify(localVector)}`)
    }
  })
  await publish({ action: "hello", peerId })
  console.log(`Peer ${peerId} subscrito e anunciado`)
}

subscribe()