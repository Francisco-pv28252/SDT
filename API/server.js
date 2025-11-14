import fastify from "fastify";
import { create } from "ipfs-http-client";
import { pipeline } from "@xenova/transformers";

const server = fastify();
const ipfs = create({ host: "localhost", port: 5001, protocol: "http" });

await server.register(import("@fastify/multipart"));

const TOPIC = "mensagens-sistema";

let cidVector = [];
let embedder;

async function subscribeToMessages() {
    const handler = (msg) => {
        const mensagem = new TextDecoder("utf-8").decode(msg.data);

        try {
            const data = JSON.parse(mensagem);

            console.log("CID recebido:", data.cid);
            console.log("Vers찾o:", data.version);
            console.log("Embedding (limitado) length:", data.embedding.length);

            if (data.version === cidVector.length + 1) {
                cidVector.push(data.cid);
                console.log("Vetor atualizado:", cidVector);
            }

        } catch (err) {
            console.log("Mensagem recebida (n찾o JSON):", mensagem);
        }
    };

    await ipfs.pubsub.subscribe(TOPIC, handler);
    console.log(`Subscrito ao t처pico ${TOPIC}`);
}

server.post('/mensagem', async (req, res) => {
    const { mensagem } = req.body;

    if (!mensagem) {
        return res.code(400).send({ error: 'Mensagem n찾o fornecida' });
    }

    await ipfs.pubsub.publish(TOPIC, Buffer.from(mensagem, "utf-8"));
    return { status: 'Mensagem enviada', mensagem };
});

server.post('/files', async (req, res) => {
    try {
        if (!embedder) {
            return res.code(503).send({ error: "Modelo ainda a carregar. Tenta novamente." });
        }

        const file = await req.file();
        if (!file) {
            return res.code(400).send({ error: "Nenhum ficheiro enviado" });
        }

        const meta = { path: file.filename, content: file.file };
        const response = await ipfs.add(meta);
        const cid = response.cid.toString();

        const newVersion = cidVector.length + 1;

        const contentBuffer = await file.toBuffer();
        const text = contentBuffer.toString("utf8");

        const rawEmbedding = await embedder(text, { pooling: "mean" });
        const embedding = Array.from(rawEmbedding.data);

        const LIMITED_SIZE = 5;
        const limitedEmbedding = embedding.slice(0, LIMITED_SIZE);

        const updateMessage = {
            type: "update",
            version: newVersion,
            cid: cid,
            embedding: limitedEmbedding
        };

        console.log("Vetor antigo:", [...cidVector]);
        cidVector.push(cid);
        console.log("Vetor novo:", [...cidVector]);

        await ipfs.pubsub.publish(
            TOPIC,
            Buffer.from(JSON.stringify(updateMessage), "utf-8")
        );

        return {
            cid,
            filename: file.filename,
            embeddingSize: limitedEmbedding.length
        };

    } catch (err) {
        console.error("Erro ao processar ficheiro:", err);
        return res.code(500).send({ error: "Erro ao processar ficheiro" });
    }
});

server.listen({ port: 5323 }, async () => {
    console.log("Servidor a correr na porta 5323");
    console.log("A carregar modelo de embeddings...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("Modelo de embeddings carregado!");
    await subscribeToMessages();
});