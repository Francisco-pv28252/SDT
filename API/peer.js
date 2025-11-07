import { create } from "ipfs-http-client";
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" });
const TOPIC = "mensagens-sistema";

let currentVersion = 0;
const cids = [];
const tempEmbeddings = [];

function calcularHash(vetor) {
  return String(vetor.join("|").hashCode || vetor.length);
}

await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
  const data = JSON.parse(new TextDecoder().decode(msg.data));

  if (data.action === "propose") {
    console.log(`Proposta recebida: versão=${data.version}, CID=${data.cid}`);

    if (data.version <= currentVersion) {
      console.log("Conflito de versão detectado (a resolver futuramente).");
      return;
    }

    const newVector = [...cids, data.cid];
    const hash = calcularHash(newVector);
    tempEmbeddings.push({ version: data.version, cid: data.cid, embedding: data.embedding });

    await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify({
      action: "confirm",
      version: data.version,
      hash
    })));

    console.log(`Enviada confirmação da versão ${data.version}`);
  }

  if (data.action === "commit") {
    if (data.version > currentVersion) {
      currentVersion = data.version;
      cids.push(tempEmbeddings.find(e => e.version === data.version).cid);
      console.log(`Commit confirmado: versão ${currentVersion}`);
    }
  }
});

console.log("Peer a ouvir o tópico", TOPIC);
