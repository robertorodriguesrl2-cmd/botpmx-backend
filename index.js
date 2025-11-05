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

app.post("/webhooks/meta", (req,res)=>{
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const value = entry?.changes?.[0]?.value;

    if (value?.messages?.length) {
      const m = value.messages[0];
      console.log(`[INCOMING] from=${m.from} text="${m.text?.body||""}"`);
    }

    if(value?.statuses?.length){
      console.log("[STATUS]", value.statuses[0]);
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
