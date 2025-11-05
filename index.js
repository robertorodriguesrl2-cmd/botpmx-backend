import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.use(morgan("tiny"));
app.use(bodyParser.json());
app.use(cors({ origin: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "pmx-verify-123";
const WABA_TOKEN   = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const BASIC_TOKEN  = process.env.BASIC_TOKEN || "";

function requireBasicAuth(req,res,next){
  const auth = req.headers.authorization || "";
  if (!BASIC_TOKEN || auth === `Bearer ${BASIC_TOKEN}`) return next();
  return res.status(401).json({ error:"unauthorized" });
}

app.get("/webhooks/meta", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhooks/meta", async (req, res) => {
  // o WhatsApp exige 200 rápido
  res.sendStatus(200);

  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // logs de status (entregue, lido etc.)
    if (value?.statuses?.length) {
      console.log("[STATUS]", value.statuses[0]);
      return;
    }

    // só processa mensagens
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;                  // número do usuário (sem +)
    const type = msg.type;
    const text = msg.text?.body?.trim() || "";

    console.log(`[INCOMING] from=${from} type=${type} text="${text}"`);

    // regra simples: responder a texto
    if (type === "text") {
      const lower = text.toLowerCase();
      if (["oi","ola","olá","bom dia","boa tarde","boa noite"].some(k => lower.includes(k))) {
        await sendText(from, "👋 Olá! Sou o BotPMXzap. Como posso ajudar?");
      } else if (lower.includes("menu")) {
        await sendText(from, "📋 *Menu*\n1) Status\n2) Ajuda\n3) Falar com atendente");
      } else {
        await sendText(from, "Recebi sua mensagem! Em breve eu te respondo 🤖");
      }
    } else {
      await sendText(from, "Recebi sua mensagem 👍 (tipo diferente de texto)");
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});


app.post("/api/whatsapp/send", requireBasicAuth, async (req,res)=>{
  try{
    const { to, text } = req.body;
    const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
    const r = await axios.post(url,{
      messaging_product:"whatsapp",
      to,
      type:"text",
      text:{ body:text }
    },{
      headers:{ Authorization:`Bearer ${WABA_TOKEN}` }
    });
    res.json(r.data);
  }catch(e){
    res.status(500).json({ error:"send_failed", detail: e?.response?.data || e.message });
  }
});

app.get("/",(_,res)=>res.send("BotPMXzap Backend OK"));
app.listen(PORT, ()=>console.log("Listening..." + PORT));
async function sendText(to, body) {
  if (!WABA_TOKEN || !PHONE_ID) {
    console.error("Faltam variáveis WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID");
    return;
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      },
      { headers: { Authorization: `Bearer ${WABA_TOKEN}` } }
    );
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err?.response?.data || err.message);
  }
}
