import { create } from "ipfs-http-client";
import { pipeline } from "@xenova/transformers";

const ipfs = create({ host: "localhost", port: 5001, protocol: "http" });
const TOPIC = "mensagens-sistema";

let currentVersion = 0;
const cids = [];
const tempEmbeddings = [];
let embedder;
const peerId = "peer-7582";

function hashVector(v) {
  return v.map(x => x.cid).join("|").split("").reduce((a, c) => (a + c.charCodeAt(0)) % 100000, 0);
}

await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
  const data = JSON.parse(new TextDecoder().decode(msg.data));

  if (data.action === "propose") {
    if (data.version <= currentVersion) return;

    const newVector = data.saveddata || [];
    const hash = hashVector(newVector);

    const ack = { action: "ack", version: data.version, peerId, hash };
    await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(ack), "utf-8"));
    console.log(`ACK enviado (versão ${data.version}, hash=${hash})`);
  }

  if (data.action === "commit") {
    if (data.version <= currentVersion) return;

    const { version, cid, embedding } = data;
    currentVersion = version;
    cids.push({ version, cid });
    tempEmbeddings.push({ version, cid, embedding });
    console.log(`Commit confirmado: versão ${version}, CID=${cid}`);
  }
});

console.log("Peer ativo e subscrito ao tópico", TOPIC);
embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
