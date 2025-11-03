import fastify from "fastify";
import {create} from "ipfs-http-client";
import { pipeline } from "@xenova/transformers";

const server = fastify();
const ipfs = create({host:"localhost",port:5001,protocol:"http"});
const saveddata = [];
let embedder;

await server.register(import("@fastify/multipart"));

const TOPIC = 'mensagens-sistema';

const handler = (msg) => {
    const mensagem = new TextDecoder("utf-8").decode(msg.data);
    try {
        const data = JSON.parse(mensagem);
        console.log(`Mensagem recebida: CID=${data.cid}, versão=${data.version}, embedding.length=${data.embedding.length}`);
    } catch (err) {
        console.log("Mensagem recebida (não JSON):", mensagem);
    }
};

async function subscribeToMessages() {
    const handler = (msg) => {
        const mensagem = new TextDecoder("utf-8").decode(msg.data);
        console.log(`Mensagem recebida de ${msg.from}: ${mensagem}`);
    };

    await ipfs.pubsub.subscribe(TOPIC, handler);
    console.log(`Subscrito ao tópico ${TOPIC}`);
}

server.post('/mensagem', async (req, res) => {
    const { mensagem } = req.body;
    console.log(mensagem)

    if (!mensagem) {
        return res.code(400).send({ error: 'Mensagem não fornecida' });
    }

    await ipfs.pubsub.publish(TOPIC, Buffer.from(mensagem, "utf-8"));
    return { status: 'Mensagem enviada', mensagem };
});

server.post('/files', async (req, res) => {
    try {
        if (!embedder) {
            return res.code(503).send({ error: "Modelo de embeddings ainda a carregar. Tente novamente em alguns segundos." });
        }

        const file = await req.file();
        if (!file) return res.code(400).send({ error: 'Nenhum ficheiro enviado' });

        const meta = { path: file.filename, content: file.file };
        const response = await ipfs.add(meta);
        const cid = response.cid.toString();

        const fileBuffer = await file.toBuffer();
        let text = fileBuffer.toString("utf-8").replace(/\0/g, ""); 
        text = text.slice(0, 1000); 

        console.log(`A gerar embeddings para o ficheiro: ${file.filename}...`);

        const output = await embedder(text, { pooling: "mean", normalize: true });
        const vector = output.data; 

        console.log("Embedding gerado (primeiros 5 valores):", vector.slice(0, 5));
        console.log(`Dimensão do vetor: ${vector.length}`);

        saveddata.push({
            version: 1,
            cid: cid,
            embedding: vector
        });

        await ipfs.pubsub.publish(TOPIC, Buffer.from(JSON.stringify({ saveddata }), "utf-8"));


        return {
            cid: response,
            filename: file.filename,
            embeddingLength: vector.length
        };
    } catch (err) {
        console.error("Erro ao gerar embedding:", err);
        return res.code(500).send({ error: "Erro ao gerar embedding" });
    }
});




server.listen({ port: 5323 }, async () => {
    console.log('Servidor a correr na porta 5323');
    console.log("A carregar modelo de embeddings...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("Modelo de embeddings carregado com sucesso!");
    await subscribeToMessages();
});
