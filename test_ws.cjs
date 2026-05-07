const WebSocket = require('ws');
const ws = new WebSocket('wss://contract.mexc.com/edge');

ws.on('open', () => {
    console.log('Connected');
    ws.send(JSON.stringify({ method: 'sub.tickers', param: {} }));
    setTimeout(() => {
        ws.send(JSON.stringify({ method: 'sub.ticker', param: {} }));
    }, 1000);
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.channel === 'push.tickers' || msg.channel === 'push.ticker') {
        console.log('TICKER:', msg);
        process.exit(0);
    } else {
        console.log('MSG:', msg);
    }
});
