import fastify from "fastify";
import { create } from "ipfs-http-client";
import { pipeline } from "@xenova/transformers";

const server = fastify();
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" });
const saveddata = [];
const prevsaveddata = [];
const localEmbeddings = [];
const confirmations = new Map();
const REQUIRED_PEERS = ["peer1", "peer2", "peer3"];
let embedder;
let v = 1;

await server.register(import("@fastify/multipart"));

const TOPIC = "mensagens-sistema";

async function subscribeToMessages() {
  await ipfs.pubsub.subscribe(TOPIC, async (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data);
    try {
      const data = JSON.parse(mensagem);

      if (data.action === "ack" && typeof data.version === "number") {
        if (!confirmations.has(data.version)) confirmations.set(data.version, new Set());
        confirmations.get(data.version).add(data.peerId);
        console.log(`ACK de ${data.peerId} para versão ${data.version}`);
        return;
      }

      if (data.action === "commit") {
        console.log(`Commit recebido: versão=${data.version}, cid=${data.cid}`);
        return;
      }

      console.log("Mensagem recebida:", mensagem);
    } catch (err) {
      console.log("Mensagem não JSON:", mensagem);
    }
  });

  console.log(`Subscrito ao tópico ${TOPIC}`);
}

server.post("/files", async (req, res) => {
  try {
    const file = await req.file();
    if (!file) return res.code(400).send({ error: "Nenhum ficheiro enviado" });

    const fileBuffer = await file.toBuffer();
    const filename = file.filename || "unnamed";
    const candidateVersion = v + 1;

    const proposta = {
      action: "propose",
      version: candidateVersion,
      filename,
      size: fileBuffer.length,
    };

    await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(proposta), "utf-8"));
    console.log(`Proposta enviada (versão=${candidateVersion}, ficheiro=${filename})`);

    confirmations.set(candidateVersion, new Set());
    const TIMEOUT_MS = 20000;

    const waitForAllPeers = () =>
      new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const confirmed = confirmations.get(candidateVersion);
          if (confirmed && REQUIRED_PEERS.every((p) => confirmed.has(p))) return resolve(true);
          if (Date.now() - start > TIMEOUT_MS) return resolve(false);
          setTimeout(check, 300);
        };
        check();
      });

    const todosConfirmaram = await waitForAllPeers();
    if (!todosConfirmaram) {
      return res
        .code(409)
        .send({ error: "Nem todos os peers confirmaram a nova versão. Operação abortada." });
    }

    const meta = { path: filename, content: fileBuffer };
    const response = await ipfs.add(meta);
    const cid = response.cid.toString();
    console.log(`Ficheiro adicionado ao IPFS com CID=${cid}`);

    let vector = null;
    if (embedder) {
      let text = fileBuffer.toString("utf-8").replace(/\0/g, "");
      text = text.slice(0, 1000);
      const output = await embedder(text, { pooling: "mean", normalize: true });
      vector = Array.from(output.data);
    }

    v = candidateVersion;
    prevsaveddata.push([...saveddata]);
    saveddata.push({ version: v, cid });
    localEmbeddings.push({ version: v, cid, embedding: vector });

    const commitMsg = {
      action: "commit",
      version: v,
      cid,
      embedding: vector,
    };

    await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(commitMsg), "utf-8"));
    console.log(`Commit publicado: versão=${v}, CID=${cid}`);

    confirmations.delete(candidateVersion);

    return { status: "Commit enviado", version: v, cid };
  } catch (err) {
    console.error("Erro no endpoint /files:", err);
    return res.code(500).send({ error: "Erro ao processar ficheiro" });
  }
});

server.listen({ port: 5323 }, async () => {
  console.log("Servidor a correr na porta 5323");
  console.log("A carregar modelo de embeddings...");
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  console.log("Modelo de embeddings carregado");
  await subscribeToMessages();
});
