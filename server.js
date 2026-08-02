const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { 
            captchaImgUrl: '', 
            createRequestUrl: '', 
            getReportUrl: '', 
            phoneField: 'phone',
            captchaField: 'captcha',
            extraPayload: {},
            headers: {} 
        };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { captchaImgUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'phone', captchaField: 'captcha', extraPayload: {}, headers: {} };
    }
}

app.get('/health', (req, res) => res.status(200).send('Server is running healthy!'));
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'فشل حفظ الإعدادات' });
    }
});

app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode, sessionCookie, requestTimestamp } = req.body;
    const config = getSettings();

    // الترويسات الأساسية كما ظهرت في متصفحك بالضبط
    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-api-version': 'v2',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...(config.headers || {}),
        ...(sessionCookie ? { 'Cookie': sessionCookie } : {})
    };

    // -------------------------------------------------------------
    // 1. جلب صورة الكابتشا (GET) + حفظ الكوكي الأمنية المتولدة
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' });
        }

        try {
            const currentTimestamp = Date.now().toString();
            const baseUrl = config.captchaImgUrl.split('?')[0];
            const fullCaptchaUrl = `${baseUrl}?${currentTimestamp}`;

            console.log(`--- [1] جلب الكابتشا: ${fullCaptchaUrl} ---`);
            const imgRes = await axios.get(fullCaptchaUrl, { headers: baseHeaders });

            // استخراج الكوكيز المتولدة من السيرفر (مثل TS15126cf3027)
            const setCookieHeader = imgRes.headers['set-cookie'];
            const newCookie = setCookieHeader ? setCookieHeader.join('; ') : sessionCookie || '';

            let base64Image = '';
            if (typeof imgRes.data === 'object' && imgRes.data !== null) {
                base64Image = imgRes.data.imageB64 || imgRes.data.captcha || imgRes.data.image || '';
            } else if (typeof imgRes.data === 'string') {
                try {
                    const parsed = JSON.parse(imgRes.data);
                    base64Image = parsed.imageB64 || parsed.captcha || parsed.image || '';
                } catch (e) {
                    base64Image = imgRes.data;
                }
            }

            if (base64Image && !base64Image.startsWith('data:image')) {
                base64Image = `data:image/png;base64,${base64Image}`;
            }

            return res.json({
                success: false,
                requireCaptcha: true,
                captchaImage: base64Image,
                sessionCookie: newCookie,
                requestTimestamp: currentTimestamp
            });

        } catch (err) {
            console.error('خطأ جلب الكابتشا:', err.response ? err.response.data : err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'فشل جلب صورة الكابتشا من الموقع الأصلي',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // 2. إرسال createRequest و getReportPrice بصيغة JSON وبنفس الكوكي
    // -------------------------------------------------------------
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';

        const mergedPayload = {
            ...(config.extraPayload || {}),
            [phoneFieldName]: phoneNumber,
            [captchaFieldName]: captchaCode
        };

        // الخطوة A: createRequest
        console.log('--- [2] إرسال طلب createRequest ---', mergedPayload);
        const createRes = await axios.post(
            config.createRequestUrl, 
            mergedPayload, 
            { headers: baseHeaders }
        );

        console.log('استجابة createRequest:', createRes.data);

        // الخطوة B: getReportPrice
        const reportPayload = {
            ...mergedPayload,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };

        console.log('--- [3] إرسال طلب getReportPrice ---', reportPayload);
        const reportRes = await axios.post(
            config.getReportUrl, 
            reportPayload, 
            { headers: baseHeaders }
        );

        return res.json({ success: true, data: reportRes.data });

    } catch (err) {
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;
        console.error(`--- خطأ تنفيذ الطلب (${status}) ---`, errData);

        return res.status(status).json({
            success: false,
            message: `فشل التنفيذ من السيرفر الأصلي (رمز: ${status})`,
            errorDetails: errData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
