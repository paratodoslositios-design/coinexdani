import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import axios from 'axios';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuración COINEX
const COINEX_API_KEY = process.env.COINEX_API_KEY;
const COINEX_API_SECRET = process.env.COINEX_API_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Validación de variables de entorno
if (!COINEX_API_KEY || !COINEX_API_SECRET || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Faltan variables de entorno críticas. Verifica tu configuración.');
  process.exit(1);
}

// Variables para almacenar datos
let ethData = {
  '15m': [],
  '4h': []
};

// Historial de señales
let signalsHistory = [];

// Función para enviar alertas a Telegram
async function sendTelegramAlert(signal) {
  const emoji = signal.type === 'BUY' ? '🟢' : '🔴';
  const message = `
${emoji} <b>Nueva Señal de Trading</b> ${emoji}
Exchange: COINEX
Par: ETH/USDT
Tipo: ${signal.type === 'BUY' ? 'COMPRA' : 'VENTA'}
Estrategia: EMA200(4H) + EMA20/50(15M)
Precio: ${signal.price.toFixed(2)} USDT
Hora: ${signal.timestamp.toLocaleString()}
  `;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('✅ Alerta enviada a Telegram');
  } catch (error) {
    console.error('❌ Error enviando alerta a Telegram:', error.message);
  }
}

// 🔥 FUNCIÓN CORREGIDA - Calcula EMA correctamente
function calculateEMA(data, period) {
  if (data.length < period) return null;
  
  // Invertir los datos para procesar de más antiguo a más reciente
  const reversedData = [...data].reverse();
  
  // Calcular SMA inicial (promedio simple de los primeros 'period' períodos)
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += reversedData[i].close;
  }
  let ema = sum / period;
  
  // Calcular EMA para el resto de los datos usando la fórmula correcta
  const k = 2 / (period + 1);
  for (let i = period; i < reversedData.length; i++) {
    ema = (reversedData[i].close * k) + (ema * (1 - k));
  }
  
  return ema;
}

// Función para verificar señales
function checkTradingSignals() {
  // Requerimos suficiente data para calcular los indicadores
  if (ethData['15m'].length < 51 || ethData['4h'].length < 201) {
    console.log('⏳ Esperando suficientes datos para calcular señales...');
    return;
  }

  const current15m = ethData['15m'][0];
  const current4h = ethData['4h'][0];

  // Calcular EMAs actuales
  const ema200_4h = calculateEMA(ethData['4h'], 200);
  const ema20_15m = calculateEMA(ethData['15m'], 20);
  const ema50_15m = calculateEMA(ethData['15m'], 50);

  if (!ema200_4h || !ema20_15m || !ema50_15m) {
    console.log('❌ Error calculando EMAs');
    return;
  }

  // Determinar tendencia 4H
  const trend4h = current4h.close > ema200_4h ? 'bullish' : 'bearish';

  // Calcular EMAs de la vela anterior (sin la vela más reciente)
  const prevEma20 = calculateEMA(ethData['15m'].slice(1), 20);
  const prevEma50 = calculateEMA(ethData['15m'].slice(1), 50);

  if (!prevEma20 || !prevEma50) return;

  // 🔍 DEBUG LOGGING - Verás esto en los logs de Render
  console.log('📊 Datos para señal:');
  console.log(`   Precio actual: ${current15m.close.toFixed(2)}`);
  console.log(`   Tendencia 4H: ${trend4h} (EMA200: ${ema200_4h.toFixed(2)})`);
  console.log(`   EMA20 actual: ${ema20_15m.toFixed(2)}, anterior: ${prevEma20.toFixed(2)}`);
  console.log(`   EMA50 actual: ${ema50_15m.toFixed(2)}, anterior: ${prevEma50.toFixed(2)}`);

  // Señal de COMPRA
  if (trend4h === 'bullish' && prevEma20 <= prevEma50 && ema20_15m > ema50_15m) {
    const signal = {
      type: 'BUY',
      price: current15m.close,
      timestamp: new Date(),
      message: 'EMA20 cruzó arriba EMA50 en 15M con tendencia alcista en 4H'
    };
    signalsHistory.unshift(signal);
    console.log('🎯 ¡SEÑAL DE COMPRA GENERADA!');
    sendTelegramAlert(signal);
  }
  
  // Señal de VENTA
  if (trend4h === 'bearish' && prevEma20 >= prevEma50 && ema20_15m < ema50_15m) {
    const signal = {
      type: 'SELL',
      price: current15m.close,
      timestamp: new Date(),
      message: 'EMA20 cruzó abajo EMA50 en 15M con tendencia bajista en 4H'
    };
    signalsHistory.unshift(signal);
    console.log('🎯 ¡SEÑAL DE VENTA GENERADA!');
    sendTelegramAlert(signal);
  }
}

// Conexión WebSocket a COINEX
function setupCOINEXWebSocket() {
  const ws = new WebSocket('wss://socket.coinex.com/');
  
  ws.on('open', () => {
    console.log('✅ Conectado a COINEX WebSocket');
    // Suscribirse a ETH/USDT 15m (900 segundos)
    ws.send(JSON.stringify({
      method: 'kline.subscribe',
      params: ['ETHUSDT', 900],
      id: 1
    }));
    // Suscribirse a ETH/USDT 4h (14400 segundos)
    ws.send(JSON.stringify({
      method: 'kline.subscribe',
      params: ['ETHUSDT', 14400],
      id: 2
    }));
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.method === 'kline.update') {
        const [symbol, interval, candleData] = message.params;
        const timeframe = interval === 900 ? '15m' : '4h';
        const candle = {
          open: parseFloat(candleData[1]),
          high: parseFloat(candleData[3]),
          low: parseFloat(candleData[4]),
          close: parseFloat(candleData[2]),
          volume: parseFloat(candleData[5]),
          timestamp: new Date(candleData[0] * 1000)
        };

        // Verificar si la vela ya existe (evitar duplicados)
        const existingIndex = ethData[timeframe].findIndex(
          vela => vela.timestamp.getTime() === candle.timestamp.getTime()
        );
        
        if (existingIndex !== -1) {
          ethData[timeframe][existingIndex] = candle; // Actualizar
        } else {
          ethData[timeframe].unshift(candle); // Nueva vela
        }

        // Mantener máximo 300 velas en memoria
        if (ethData[timeframe].length > 300) {
          ethData[timeframe].pop();
        }

        console.log(`📈 Actualizado ${timeframe}: ${candle.close.toFixed(2)} USDT`);

        // Verificar señales en cada vela de 15m
        if (timeframe === '15m') {
          checkTradingSignals();
        }
      }
    } catch (error) {
      console.error('❌ Error procesando mensaje WebSocket:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Error WebSocket COINEX:', error);
  });

  ws.on('close', () => {
    console.log('⚠️ Conexión WebSocket cerrada. Reconectando en 5 segundos...');
    setTimeout(setupCOINEXWebSocket, 5000);
  });
}

// Cargar datos históricos iniciales
async function loadHistoricalData() {
  try {
    console.log('📥 Cargando datos históricos...');
    const [res15m, res4h] = await Promise.all([
      axios.get('https://api.coinex.com/v1/market/kline', {
        params: {
          market: 'ETHUSDT',
          type: '15min',
          limit: 250
        }
      }),
      axios.get('https://api.coinex.com/v1/market/kline', {
        params: {
          market: 'ETHUSDT',
          type: '4hour',
          limit: 250
        }
      })
    ]);

    ethData['15m'] = res15m.data.data.map(item => ({
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
      timestamp: new Date(parseInt(item[0]) * 1000)
    })).reverse();

    ethData['4h'] = res4h.data.data.map(item => ({
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
      timestamp: new Date(parseInt(item[0]) * 1000)
    })).reverse();

    console.log('✅ Datos históricos cargados:', {
      '15m': ethData['15m'].length,
      '4h': ethData['4h'].length
    });
  } catch (error) {
    console.error('❌ Error cargando datos históricos:', error.message);
  }
}

// Endpoints API
app.get('/api/status', (req, res) => {
  const currentPrice = ethData['15m'].length > 0 ? ethData['15m'][0].close : null;
  res.json({
    status: 'running',
    exchange: 'COINEX',
    pair: 'ETH/USDT',
    currentPrice,
    dataPoints: {
      '15m': ethData['15m'].length,
      '4h': ethData['4h'].length
    },
    lastSignals: signalsHistory.slice(0, 5)
  });
});

app.get('/api/signals', (req, res) => {
  res.json({
    signals: signalsHistory,
    count: signalsHistory.length
  });
});

// Endpoint de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'CoinEx Monitor is running'
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`🔗 Endpoints disponibles:`);
  console.log(`   - /api/status`);
  console.log(`   - /api/signals`);
  console.log(`   - /health`);
  
  // Cargar datos históricos primero
  await loadHistoricalData();
  // Iniciar WebSocket
  setupCOINEXWebSocket();
});