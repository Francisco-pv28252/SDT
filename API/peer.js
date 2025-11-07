import { create } from "ipfs-http-client";
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" });

const TOPIC = "mensagens-sistema";
let PEER_ID = "";
const saveddata = [];

function hashVector(vetor) {
  return vetor.map(x => x.cid).join("|").split("").reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0);
}

async function getPeerId() {
  try {
    const idInfo = await ipfs.id();

    const safeAddresses = idInfo.addresses?.filter(a => !a.includes("webrtc-direct")) || [];

    PEER_ID = idInfo.id;
    console.log(`Peer ativo: ${PEER_ID}`);
    console.log("Endereços disponíveis:", safeAddresses);
  } catch (err) {
    console.error("Erro ao obter ID do peer:", err.message);
  }
}


async function subscribe() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data);
    try {
      const data = JSON.parse(mensagem);

      if (data.action === "propose") {
        console.log(`Proposta recebida: versão=${data.version}`);
        const hash = hashVector(data.saveddata);
        const ack = { action: "ack", version: data.version, peerId: PEER_ID, hash };
        await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(ack), "utf-8"));
        console.log(`ACK enviado (hash=${hash})`);
        return;
      }

      if (data.action === "commit") {
        console.log(`Commit recebido: versão=${data.version}, cid=${data.cid}`);
        if (data.saveddata) {
          saveddata.length = 0;
          saveddata.push(...data.saveddata);
          console.log("Novo vetor guardado:");
          console.table(saveddata);
        }
      }
    } catch {
      console.log("Mensagem não JSON:", mensagem);
    }
  });
  console.log(`Peer ${PEER_ID} subscrito ao tópico ${TOPIC}`);
}

await getPeerId();
await subscribe();
