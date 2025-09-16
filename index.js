// monitor-detailed.js
require('dotenv').config();
const express = require('express');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const app = express();
app.use(express.json());

// ثابت: العنوان الهدف
const TARGET_ADDRESS = new PublicKey('FUMnrwov6NuztUmmZZP97587aDZEH4WuKn8bgG6UqjXG');

// التحقق من متغيرات البيئة
if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
  console.error('❌ يجب ضبط RPC_URL و PRIVATE_KEY في ملف .env');
  process.exit(1);
}

// تطبيع RPC (Connection يحتاج http/https)
let rawRpc = process.env.RPC_URL.trim();
if (rawRpc.startsWith('wss://')) {
  console.warn('⚠️ تحويل RPC_URL من wss:// إلى https:// للاتصال');
  rawRpc = 'https://' + rawRpc.slice('wss://'.length);
} else if (rawRpc.startsWith('ws://')) {
  console.warn('⚠️ تحويل RPC_URL من ws:// إلى http:// للاتصال');
  rawRpc = 'http://' + rawRpc.slice('ws://'.length);
} else if (!rawRpc.startsWith('http://') && !rawRpc.startsWith('https://')) {
  console.error('❌ RPC_URL يجب أن يبدأ بـ http(s) أو ws(s)');
  process.exit(1);
}

// إنشاء اتصال بسرعة processed
const connection = new Connection(rawRpc, 'processed');

// تحميل المحفظة
let wallet;
try {
  const sk = bs58.decode(process.env.PRIVATE_KEY.trim());
  wallet = Keypair.fromSecretKey(sk);
} catch (err) {
  console.error('❌ خطأ في المفتاح الخاص:', err.message);
  process.exit(1);
}

console.log('🚀 Forwarder detailed started');
console.log('Wallet:', wallet.publicKey.toString());
console.log('Target:', TARGET_ADDRESS.toString());
console.log('RPC:', rawRpc);

// السجلات
const logs = [];
const sendDetails = [];

function addLog(type, msg, extra = {}) {
  const entry = { type, msg, timestamp: new Date().toISOString(), ...extra };
  logs.unshift(entry);
  if (logs.length > 1000) logs.splice(1000);
  console.log(`[${type.toUpperCase()}] ${entry.timestamp} - ${msg}`);
}

function addSendDetail(detail) {
  const entry = { id: Date.now() + '-' + Math.floor(Math.random()*1000), timestamp: new Date().toISOString(), ...detail };
  sendDetails.unshift(entry);
  if (sendDetails.length > 500) sendDetails.splice(500);
  console.log(`[SEND_DETAIL] stage=${entry.stage} sig=${entry.signature||'N/A'} total=${entry.totalDurationMs||'N/A'}ms`);
}

// إرسال كل الرصيد مع قياسات زمنية
async function forwardFundsDetailed(newBalance) {
  const detail = {
    stage: 'start',
    lamportsBalance: newBalance,
    lamportsToSend: null,
    timestamps: {},
    rpcLatency: {},
    signature: null,
    error: null,
    processedMs: null,
    confirmedMs: null,
    finalizedMs: null
  };
  const t0 = Date.now();

  try {
    const feeReserve = 5000;
    const amount = newBalance - feeReserve;
    if (amount <= 0) {
      addLog('warning', 'الرصيد لا يغطي الرسوم', { balance: newBalance });
      detail.stage = 'insufficient';
      addSendDetail({ ...detail, totalDurationMs: Date.now()-t0 });
      return;
    }
    detail.lamportsToSend = amount;

    // blockhash
    const bhStart = Date.now();
    const { blockhash } = await connection.getLatestBlockhash('processed');
    detail.rpcLatency.getBlockhashMs = Date.now() - bhStart;

    // بناء وتوقيع
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey });
    tx.add(SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: TARGET_ADDRESS,
      lamports: amount
    }));
    tx.sign(wallet);
    const raw = tx.serialize();

    // sendRawTransaction
    const sendStart = Date.now();
    let sig;
    try {
      sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
      detail.signature = sig;
      detail.rpcLatency.sendRawMs = Date.now() - sendStart;
      addLog('send', `تم إرسال ${amount / LAMPORTS_PER_SOL} SOL`, { signature: sig });
      detail.stage = 'sent';
    } catch (err) {
      detail.error = String(err);
      detail.stage = 'send_failed';
      addLog('error', `فشل sendRawTransaction: ${String(err)}`);
      addSendDetail({ ...detail, totalDurationMs: Date.now()-t0 });
      return;
    }

    // قياسات بعد الإرسال
    try {
      const pStart = Date.now();
      await connection.confirmTransaction(sig, 'processed');
      detail.processedMs = Date.now() - pStart;
    } catch {}

    try {
      const cStart = Date.now();
      await connection.confirmTransaction(sig, 'confirmed');
      detail.confirmedMs = Date.now() - cStart;
    } catch {}

    try {
      const fStart = Date.now();
      await connection.confirmTransaction(sig, 'finalized');
      detail.finalizedMs = Date.now() - fStart;
    } catch {}

    detail.totalDurationMs = Date.now() - t0;
    addSendDetail(detail);

  } catch (err) {
    detail.error = String(err);
    detail.stage = 'exception';
    detail.totalDurationMs = Date.now() - t0;
    addLog('error', `Exception أثناء الإرسال: ${String(err)}`);
    addSendDetail(detail);
  }
}

// مراقبة الحساب
let lastBalance = 0;
let subscriptionId = null;

async function startMonitor() {
  try {
    lastBalance = await connection.getBalance(wallet.publicKey, 'processed');
    addLog('info', `الرصيد الابتدائي: ${lastBalance / LAMPORTS_PER_SOL} SOL`);
    if (lastBalance > 0) forwardFundsDetailed(lastBalance);

    subscriptionId = connection.onAccountChange(
      wallet.publicKey,
      (info) => {
        const newBal = info.lamports;
        if (newBal > 0 && newBal !== lastBalance) {
          const diff = newBal - (lastBalance||0);
          addLog('receive', `رصيد جديد ${newBal/LAMPORTS_PER_SOL} SOL (+${diff/LAMPORTS_PER_SOL} SOL)`);
          forwardFundsDetailed(newBal);
        }
        lastBalance = newBal;
      },
      'processed'
    );

    addLog('info', `تم الاشتراك (id=${subscriptionId})`);
  } catch (err) {
    addLog('error', `فشل بدء المراقبة: ${String(err)}`);
  }
}

// واجهة بسيطة
app.get('/', (req,res)=>{
  res.send(`<!doctype html>
<html lang="ar"><head><meta charset="utf-8"><title>سجلات</title>
<style>body{font-family:Tahoma;direction:rtl;background:#f5f6fa;padding:20px}
.log{background:#fff;margin:8px 0;padding:8px;border-radius:6px;border-right:5px solid #ccc}
.log.send{border-color:#007bff}.log.receive{border-color:#28a745}.log.error{border-color:#dc3545}.log.info{border-color:#6c757d}
small{color:#555}.pre{white-space:pre-wrap;font-family:monospace;background:#f8f9fa;padding:6px;border-radius:4px}
</style></head><body>
<h1>📜 السجلات</h1>
<div id="logs"></div>
<h2>🔎 تفاصيل الإرسال</h2>
<div id="details"></div>
<script>
async function load(){
  const l = await fetch('/api/logs').then(r=>r.json());
  document.getElementById('logs').innerHTML = l.map(x=>'<div class="log '+x.type+'"><b>'+x.type+'</b>: '+x.msg+'<br><small>'+new Date(x.timestamp).toLocaleString()+'</small></div>').join('');
  const d = await fetch('/api/send-details?limit=5').then(r=>r.json());
  document.getElementById('details').innerHTML = d.map(x=>'<div class="log send"><div class="pre">'+JSON.stringify(x,null,2)+'</div></div>').join('');
}
load();setInterval(load,2000);
</script></body></html>`);
});

app.get('/api/logs', (req,res)=>res.json(logs));
app.get('/api/send-details',(req,res)=>res.json(sendDetails.slice(0,parseInt(req.query.limit||'20'))));

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=> console.log(`🌐 افتح http://localhost:${PORT}`));

// بدء المراقبة
startMonitor();