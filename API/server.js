import fastify from "fastify";
import {create} from "ipfs-http-client";

const server = fastify();
const ipfs = create({host:"localhost",port:5001,protocol:"http"});

await server.register(import("@fastify/multipart"));

const TOPIC = 'mensagens-sistema';


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
    const file = await req.file();

    if (!file) {
        return res.code(400).send({ error: 'You not submit a file' });
    }

    const meta = { path: file.filename, content: file.file };
    const response = await ipfs.add(meta);

    return {
        cid: response
    };
});

server.listen({ port: 5323 }, async () => {
    console.log('Servidor a correr na porta 5323');
    await subscribeToMessages();
});
