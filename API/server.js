import { create } from "ipfs-http-client";
import { TextDecoder } from "util";

const ipfs = create({ host: "localhost", port: 5001, protocol: "http" });

const TOPIC = "document-updates";

let localVector = [];
let localVersion = 0;
let index = {}; 

async function startPeer() {
    await ipfs.pubsub.subscribe(TOPIC, (msg) => {
        const dataStr = new TextDecoder().decode(msg.data);

        try {
            const data = JSON.parse(dataStr);

            if (data.type === "update") {
                console.log("\n📥 Nova atualização recebida:");
                console.log("Versão:", data.version);
                console.log("CID:", data.cid);
                console.log("Embedding length:", data.embedding.length);

                if (data.version > localVersion) {
                    localVersion = data.version;
                    localVector.push(data.cid);
                    index[data.cid] = data.embedding;

                    console.log("Vetor local atualizado:", localVector);
                }
            }

        } catch (err) {
            console.log("Mensagem inválida:", dataStr);
        }
    });

    console.log("Peer subscrito ao tópico:", TOPIC);
}

startPeer();
