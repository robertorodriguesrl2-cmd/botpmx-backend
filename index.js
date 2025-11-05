// index.js — BotPMX com IA + Funil + Analytics (v1)
//
// Requisitos de ambiente:
//  - WHATSAPP_TOKEN (WABA)
//  - WHATSAPP_PHONE_NUMBER_ID
//  - META_VERIFY_TOKEN
//  - BASIC_TOKEN (protege /api/analytics/*)
//  - AI_PROVIDER=gemini
//  - GEMINI_API_KEY
//  - AI_MODEL=gemini-1.5-flash (sugestão)
//
// Dependências: express, body-parser, axios, cors, morgan, @google/generative-ai
//
// Dica: Em dev local, o arquivo data.json salva os leads (ajuda a visualizar).
// Em produção no Render, considere um banco depois (PostgreSQL) — mas já
// deixei tudo preparado para os endpoints de analytics.

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";

// ===== IA (Gemini) =====
let askAI = async (text) => "Desculpe, não consegui entender. Pode tentar de outro jeito? 🙂";
try {
  const provider = (process.env.AI_PROVIDER || "").toLowerCase();
  if (provider === "gemini") {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    const modelName = process.env.AI_MODEL || "gemini-1.5-flash";
    askAI = async (text) => {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const prompt =
          `Você é um assistente de atendimento simpático e vendedor. ` +
          `Responda de forma curta, clara, em português do Brasil, com tom leve e alguns emojis quando fizer sentido. ` +
          `Mensagem do cliente: "${text}"`;
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        console.error("Erro IA:", err?.message || err);
        return "Tive um probleminha pra pensar aqui 😅. Pode perguntar de outra forma?";
      }
    };
  }
} catch (e) {
  console.error("Falha ao ativar IA:", e?.message || e);
}

const app = express();
app.use(morgan("tiny"));
app.use(bodyParser.json());
app.use(cors({ origin: true }));

// ===== Env =====
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "pmx-verify-123";
const WABA_TOKEN   = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const BASIC_TOKEN  = process.env.BASIC_TOKEN || "";

// ===== Aux: auth básica p/ APIs internas =====
function requireBasicAuth(req,res,next){
  const auth = req.headers.authorization || "";
  if (!BASIC_TOKEN || auth === `Bearer ${BASIC_TOKEN}`) return next();
  return res.status(401).json({ error:"unauthorized" });
}

// ===== Envio de mensagens pelo WhatsApp Graph =====
async function sendText(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  }, { headers: { Authorization: `Bearer ${WABA_TOKEN}` }});
}

async function sendMenu(to) {
  const menu =
`📋 *Menu*

1) Produtos / Serviços
2) Preços e condições
3) Falar com atendente 🤝
4) Status do pedido

Você também pode digitar sua dúvida livremente 😉`;
  await sendText(to, menu);
}

// ===== "Memória" simples: leads + funil =====
// Em produção: sugiro migrar para PostgreSQL depois.
// Aqui salvamos em memória e opcionalmente em data.json (bom pra dev).

const leads = new Map(); // key: wa_id -> leadData

// Tenta carregar data.json (dev/local)
try {
  const raw = fs.readFileSync("data.json","utf-8");
  const parsed = JSON.parse(raw);
  Object.entries(parsed).forEach(([k,v]) => leads.set(k,v));
  console.log(`Leads carregados de data.json: ${leads.size}`);
} catch (_) { /* ignore */ }

function saveToFile() {
  // Evita travar em produção; serve para dev local visualizar evolução
  try {
    const obj = Object.fromEntries(leads.entries());
    fs.writeFileSync("data.json", JSON.stringify(obj,null,2));
  } catch (e) { /* ignore */ }
}

function getOrCreateLead(waId, name="") {
  if (!leads.has(waId)) {
    leads.set(waId, {
      waId,
      name,
      firstSeenAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      stage: "inicio",          // inicio -> menu -> produto -> preco -> humano -> checkout -> concluido/abandonado
      history: [],              // { at, type, data }
    });
  }
  const lead = leads.get(waId);
  if (name && !lead.name) lead.name = name;
  return lead;
}

function track(waId, type, data={}) {
  const lead = getOrCreateLead(waId);
  lead.history.push({ at: new Date().toISOString(), type, data });
  lead.lastMessageAt = new Date().toISOString();

  // estágio automático por alguns eventos
  switch(type) {
    case "menu_mostrado": lead.stage = "menu"; break;
    case "menu_opcao_1":  lead.stage = "produto"; break;
    case "menu_opcao_2":  lead.stage = "preco"; break;
    case "menu_opcao_3":  lead.stage = "humano"; break;
    case "status_pedido": lead.stage = "status"; break;
    case "ia_respondeu":  /* mantém estágio */ break;
    case "inicio_conversa": /* mantém estágio */ break;
    default: break;
  }

  // persistência local (dev)
  saveToFile();
}

// ===== Webhook (GET) - verificação =====
app.get("/webhooks/meta", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Webhook (POST) - mensagens/status =====
app.post("/webhooks/meta", async (req,res)=>{
  // Sempre 200 primeiro
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // Mensagens recebidas
    if (value?.messages?.length) {
      const m = value.messages[0];
      const msgType = m.type; // text, interactive, etc.
      const waId = m.from;    // número do cliente
      const name = value.contacts?.[0]?.profile?.name || "";
      const text = m.text?.body?.trim() || "";

      console.log(`[INCOMING] from=${waId} name="${name}" type=${msgType} text="${text}"`);

      // Cria/atualiza lead e registra começo da conversa
      const lead = getOrCreateLead(waId, name);
      if (lead.history.length === 0) {
        track(waId, "inicio_conversa", { source: "whatsapp" });
        // Mostra menu no primeiro contato
        await sendText(waId, `Olá ${name || ""}! Eu sou o *Assistente PMX*. Como posso ajudar hoje? 😊`);
        await sendMenu(waId);
        track(waId, "menu_mostrado");
        return;
      }

      // Roteador simples por texto
      const lower = text.toLowerCase();

      // Atalhos
      if (["menu","início","inicio","voltar"].includes(lower)) {
        await sendMenu(waId);
        track(waId, "menu_mostrado");
        return;
      }

      // Opções do menu
      if (lower === "1") {
        // Produtos/Serviços
        await sendText(waId,
`🛍️ *Nossos Produtos/Serviços*
• Produto A — ideal para quem está começando
• Produto B — performance avançada
• Serviço C — implementação completa

Se quiser, posso te recomendar algo com base no que você precisa 🙂`);
        track(waId, "menu_opcao_1");
        return;
      }

      if (lower === "2") {
        // Preços e condições
        await sendText(waId,
`💲 *Preços e condições*
Temos planos flexíveis. Posso te indicar o melhor custo-benefício.
• Pagamento no cartão ou PIX
• Descontos à vista

Quer que eu simule um plano pra você? 😉`);
        track(waId, "menu_opcao_2");
        return;
      }

      if (lower === "3") {
        // Falar com humano
        await sendText(waId,
`🧑‍💼 Tudo bem! Vou te colocar com um atendente humano agora.
*Dica:* Se quiser voltar ao menu depois, digite *menu*.`);
        track(waId, "menu_opcao_3");
        return;
      }

      if (lower === "4") {
        // Status do pedido (placeholder genérico)
        await sendText(waId,
`📦 *Status do pedido*
Me diga seu código/ID do pedido que eu verifico pra você 😉`);
        track(waId, "status_pedido");
        return;
      }

      // Caso não reconheça a opção, aciona IA generativa
      const answer = await askAI(text);
      await sendText(waId, answer);
      track(waId, "ia_respondeu", { question: text, answer });
      return;
    }

    // Status de mensagens (entregue, lida, etc.)
    if (value?.statuses?.length) {
      console.log("[STATUS]", value.statuses[0]);
      return;
    }

  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e?.message || e);
  }
});

// ===== Endpoint manual para enviar texto (útil em testes) =====
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

// ===== Analytics (resumo/funil/leads) =====
app.get("/api/analytics/summary", requireBasicAuth, (req,res)=>{
  const totalLeads = leads.size;

  const byStage = {};
  for (const { stage } of leads.values()) {
    byStage[stage] = (byStage[stage] || 0) + 1;
  }

  const totalMsgsIA = Array.from(leads.values())
    .reduce((acc, l) => acc + l.history.filter(h => h.type==="ia_respondeu").length, 0);

  res.json({
    totalLeads,
    byStage,
    totalMsgsIA,
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/analytics/funnel", requireBasicAuth, (req,res)=>{
  // Contagem por evento do funil
  const funnel = {
    inicio: 0,
    menu: 0,
    produto: 0,
    preco: 0,
    humano: 0,
    status: 0
  };

  for (const l of leads.values()) {
    // etapa atual
    if (funnel[l.stage] !== undefined) funnel[l.stage]++;
  }

  res.json({
    funnel,
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/analytics/leads", requireBasicAuth, (req,res)=>{
  res.json({
    leads: Array.from(leads.values()),
    count: leads.size,
    updatedAt: new Date().toISOString()
  });
});

app.get("/",(_,res)=>res.send("BotPMX Backend OK ✅"));
app.listen(PORT, ()=>console.log("Listening..." + PORT));
