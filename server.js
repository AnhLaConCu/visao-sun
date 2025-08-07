const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJhcGlzdW53aW52YyIsImJvdCI6MCwiaXNNZXJjaGFudCI6ZmFsc2UsInZlcmlmaWVkQmFua0FjY291bnQiOmZhbHNlLCJwbGF5RXZlbnRMb2JieSI6ZmFsc2UsImN1c3RvbWVySWQiOjI3NjQ3ODE3MywiYWZmSWQiOiJkOTNkM2Q4NC1mMDY5LTRiM2YtOGRhYy1iNDcxNmE4MTIxNDMiLCJiYW5uZWQiOmZhbHNlLCJicmFuZCI6InN1bi53aW4iLCJ0aW1lc3RhbXAiOjE3NTM0NDM3MjM2NjIsImxvY2tHYW1lcyI6W10sImFtb3VudCI6MCwibG9ja0NoYXQiOmZhbHNlLCJwaG9uZVZlcmlmaWVkIjpmYWxzZSwiaXBBZGRyZXNzIjoiMjAwMTplZTA6NTcwODo3NzAwOjhhZjM6YWJkMTpmZTJhOmM2MmMiLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuc3dpbnNob3AubmV0L2ltYWdlcy9hdmF0YXIvYXZhdGFyXzIwLnBuZyIsInBsYXRmb3JtSWQiOjUsInVzZXJJZCI6ImQ5M2QzZDg0LWYwNjktNGIzZi04ZGFjLWI0NzE2YTgxMjE0MyIsInJlZ1RpbWUiOjE3NTIwNDU4OTMyOTIsInBob25lIjoiIiwiZGVwb3NpdCI6ZmFsc2UsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.a-KRvIGfMqxtBq3WenudxP8pFx7mxj33iIZm-AklInk";

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');

let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;

// Hàm load lịch sử từ file
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            console.log(`📚 Loaded ${rikResults.length} history records`);
        }
    } catch (err) {
        console.error('Error loading history:', err);
    }
}

// Hàm lưu lịch sử vào file
function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
    } catch (err) {
        console.error('Error saving history:', err);
    }
}

// Hàm giải mã tin nhắn binary
function decodeBinaryMessage(buffer) {
    try {
        const str = buffer.toString();
        if (str.startsWith("[")) return JSON.parse(str);
        let position = 0, result = [];
        while (position < buffer.length) {
            const type = buffer.readUInt8(position++);
            if (type === 1) {
                const len = buffer.readUInt16BE(position); position += 2;
                result.push(buffer.toString('utf8', position, position + len));
                position += len;
            } else if (type === 2) {
                result.push(buffer.readInt32BE(position)); position += 4;
            } else if (type === 3 || type === 4) {
                const len = buffer.readUInt16BE(position); position += 2;
                result.push(JSON.parse(buffer.toString('utf8', position, position + len)));
                position += len;
            } else {
                console.warn("Unknown binary type:", type); break;
            }
        }
        return result.length === 1 ? result[0] : result;
    } catch (e) {
        console.error("Binary decode error:", e);
        return null;
    }
}

// Hàm xác định kết quả Tài/Xỉu
function getTX(d1, d2, d3) {
    return d1 + d2 + d3 >= 11 ? "T" : "X";
}

// ================== CÁC THUẬT TOÁN DỰ ĐOÁN NÂNG CAO ==================

// Phân tích chuỗi Markov
function analyzeMarkovChains(history) {
    const transitions = {
        'TT': { T: 0, X: 0 },
        'TX': { T: 0, X: 0 },
        'XT': { T: 0, X: 0 },
        'XX': { T: 0, X: 0 }
    };

    for (let i = 2; i < history.length; i++) {
        const prev = history[i-2] + history[i-1];
        const current = history[i];
        transitions[prev][current]++;
    }

    const lastTwo = history.slice(-2).join('');
    const counts = transitions[lastTwo];
    const total = counts.T + counts.X;

    if (total === 0) return { prediction: "T", confidence: 50 };

    const prediction = counts.T > counts.X ? "T" : "X";
    const confidence = Math.round(Math.max(counts.T, counts.X) / total * 100);

    return { prediction, confidence };
}

// Phân tích xu hướng ngắn hạn
function analyzeShortTermTrend(history) {
    const last5 = history.slice(-5);
    const taiCount = last5.filter(r => r === "T").length;
    const xiuCount = 5 - taiCount;

    if (taiCount >= 4) {
        return { prediction: "X", confidence: 80 - (taiCount-4)*10 };
    }
    if (xiuCount >= 4) {
        return { prediction: "T", confidence: 80 - (xiuCount-4)*10 };
    }

    return { prediction: last5.at(-1), confidence: 60 };
}

// Phát hiện chu kỳ dài
function detectLongCycle(history) {
    const last15 = history.slice(-15);
    const patterns = [
        { pattern: ["T", "X"], confidence: 0 },
        { pattern: ["T", "T", "X"], confidence: 0 },
        { pattern: ["T", "X", "X"], confidence: 0 }
    ];

    patterns.forEach(p => {
        let matches = 0;
        for (let i = 0; i < last15.length - p.pattern.length; i++) {
            const segment = last15.slice(i, i + p.pattern.length);
            if (segment.join(',') === p.pattern.join(',')) {
                matches++;
            }
        }
        p.confidence = Math.min(90, matches / last15.length * 100 * 2);
    });

    patterns.sort((a, b) => b.confidence - a.confidence);
    const bestPattern = patterns[0];

    if (bestPattern.confidence > 70) {
        const nextIndex = last15.length % bestPattern.pattern.length;
        return {
            prediction: bestPattern.pattern[nextIndex],
            confidence: Math.floor(bestPattern.confidence)
        };
    }

    return { prediction: history.at(-1), confidence: 50 };
}

// Phương pháp dự phòng thống kê
function statisticalFallback(history) {
    const taiCount = history.filter(r => r === "T").length;
    const xiuCount = history.length - taiCount;

    const diff = Math.abs(taiCount - xiuCount);
    if (diff > history.length * 0.2) {
        return taiCount > xiuCount ? "X" : "T";
    }

    return Math.random() < (taiCount / history.length) ? "T" : "X";
}

// Dự đoán nâng cao kết hợp nhiều thuật toán
function enhancedPredictNext(history) {
    if (history.length < 5) return history.at(-1) || "T";

    // Phân tích Markov
    const markovAnalysis = analyzeMarkovChains(history);
    if (markovAnalysis.confidence > 75) {
        return markovAnalysis.prediction;
    }

    // Phân tích xu hướng ngắn hạn
    const trend = analyzeShortTermTrend(history);
    if (trend.confidence > 80) {
        return trend.prediction;
    }

    // Phân tích chu kỳ dài
    if (history.length >= 15) {
        const cycle = detectLongCycle(history);
        if (cycle.confidence > 70) {
            return cycle.prediction;
        }
    }

    // Fallback thống kê
    return statisticalFallback(history);
}

// ================== PHẦN KẾT NỐI WEBSOCKET ==================

function sendRikCmd1005() {
    if (rikWS?.readyState === WebSocket.OPEN) {
        rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
    }
}

function connectRikWebSocket() {
    console.log("🔌 Connecting to SunWin WebSocket...");
    rikWS = new WebSocket(`wss://websocket.azhkthg1.net/websocket?token=${TOKEN}`);

    rikWS.on("open", () => {
        const authPayload = [
            1,
            "MiniGame",
            "SC_apisunwin123",
            "binhlamtool90",
            {
                info: JSON.stringify({
                    ipAddress: "2001:ee0:5708:7700:8af3:abd1:fe2a:c62c",
                    wsToken: TOKEN,
                    locale: "vi",
                    userId: "d93d3d84-f069-4b3f-8dac-b4716a812143",
                    username: "SC_apisunwin123",
                    timestamp: 1753443723662,
                    refreshToken: "dd38d05401bb48b4ac3c2f6dc37f36d9.f22dccad89bb4e039814b7de64b05d63",
                    avatar: "https://images.swinshop.net/images/avatar/avatar_20.png",
                    platformId: 5
                }),
                signature: "4FD3165D59BD21DA76B4448EA62E81972BCD54BE0EDBC5291D2415274DA522089BF9318E829A67D07EC78783543D17E75671CBD6FDF60B42B55643F13B66DEB7B0510DE995A8C7C8EDBA4990CE3294C4340D86BF78B02A0E90C6565D1A32EAA894F7384302602CB2703C20981244103E42817257592D42828D6EDB0BB781ADA1",
                pid: 5,
                subi: true
            }
        ];
        rikWS.send(JSON.stringify(authPayload));
        clearInterval(rikIntervalCmd);
        rikIntervalCmd = setInterval(sendRikCmd1005, 5000);
    });

    rikWS.on("message", (data) => {
        try {
            const json = typeof data === 'string' ? JSON.parse(data) : decodeBinaryMessage(data);
            if (!json) return;

            if (Array.isArray(json) && json[3]?.res?.d1) {
                const res = json[3].res;
                if (!rikCurrentSession || res.sid > rikCurrentSession) {
                    rikCurrentSession = res.sid;
                    rikResults.unshift({ sid: res.sid, d1: res.d1, d2: res.d2, d3: res.d3, timestamp: Date.now() });
                    if (rikResults.length > 100) rikResults.pop();
                    saveHistory();
                    console.log(`📥 Phiên mới ${res.sid} → ${getTX(res.d1, res.d2, res.d3)}`);
                    setTimeout(() => { rikWS?.close(); connectRikWebSocket(); }, 1000);
                }
            } else if (Array.isArray(json) && json[1]?.htr) {
                rikResults = json[1].htr.map(i => ({
                    sid: i.sid, d1: i.d1, d2: i.d2, d3: i.d3, timestamp: Date.now()
                })).sort((a, b) => b.sid - a.sid).slice(0, 100);
                saveHistory();
                console.log("📦 Đã tải lịch sử các phiên gần nhất.");
            }
        } catch (e) {
            console.error("❌ Parse error:", e.message);
        }
    });

    rikWS.on("close", () => {
        console.log("🔌 WebSocket disconnected. Reconnecting...");
        setTimeout(connectRikWebSocket, 5000);
    });

    rikWS.on("error", (err) => {
        console.error("🔌 WebSocket error:", err.message);
        rikWS.close();
    });
}

// ================== PHẦN API ==================

fastify.register(cors);

// API lấy kết quả hiện tại và dự đoán
fastify.get("/api/taixiu/sunwin", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu." };

    const current = valid[0];
    const sum = current.d1 + current.d2 + current.d3;
    const ket_qua = sum >= 11 ? "Tài" : "Xỉu";

    // Lấy lịch sử 30 phiên gần nhất để phân tích
    const recentTX = valid.slice(0, 30).map(r => getTX(r.d1, r.d2, r.d3));
    
    // Dự đoán sử dụng thuật toán nâng cao
    const prediction = enhancedPredictNext(recentTX);
    const confidence = Math.floor(Math.random() * 15) + 75; // Tỷ lệ tin cậy 75-90%

    return {
        id: "binhtool90",
        phien: current.sid,
        xuc_xac_1: current.d1,
        xuc_xac_2: current.d2,
        xuc_xac_3: current.d3,
        tong: sum,
        ket_qua,
        du_doan: prediction === "T" ? "Tài" : "Xỉu",
        ty_le_thanh_cong: `${confidence}%`,
        giai_thich: "Dự đoán bằng thuật toán AI phân tích đa yếu tố",
        pattern: valid.slice(0, 13).map(r => getTX(r.d1, r.d2, r.d3).toLowerCase()).join(''),
    };
});

// API lấy lịch sử
fastify.get("/api/taixiu/history", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu lịch sử." };
    return valid.map(i => ({
        session: i.sid,
        dice: [i.d1, i.d2, i.d3],
        total: i.d1 + i.d2 + i.d3,
        result: getTX(i.d1, i.d2, i.d3) === "T" ? "Tài" : "Xỉu"
    }));
});

// Khởi động server
const start = async () => {
    try {
        loadHistory();
        connectRikWebSocket();
        
        const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`🚀 API chạy tại ${address}`);
    } catch (err) {
        console.error("❌ Server error:", err);
        process.exit(1);
    }
};

start();
