const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { 
            captchaImgUrl: '', 
            verifyCaptchaUrl: '', 
            createRequestUrl: '', 
            getReportUrl: '', 
            phoneField: 'phone',
            captchaField: 'captcha',
            headers: {} 
        };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { captchaImgUrl: '', verifyCaptchaUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'phone', captchaField: 'captcha', headers: {} };
    }
}

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
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    // إدارة الكوكيز والجلسة
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        headers: config.headers || {},
        timeout: 15000,
        withCredentials: true
    }));

    // -------------------------------------------------------------
    // المرحلة الأولى: جلب صورة الكابتشا
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'تنبيه: لم يتم ضبط رابط الكابتشا في لوحة التحكم' });
        }

        try {
            const imgRes = await client.get(config.captchaImgUrl);
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

            if (!base64Image) {
                return res.status(500).json({ success: false, message: 'فشل جلب الكابتشا: لم يتم العثور على حقل imageB64 في الاستجابة' });
            }

            return res.json({
                success: false,
                requireCaptcha: true,
                captchaImage: base64Image
            });

        } catch (err) {
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ أثناء جلب صورة الكابتشا من الموقع الأصلي',
                step: 'GET_CAPTCHA_IMAGE',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // المرحلة الثانية: تنفيذ الخطوات الثلاث المتتالية وتخصيص رسائل الخطأ
    // -------------------------------------------------------------

    // الخطوة 1: التحقق من الكابتشا (POST /i)
    let verifyRes;
    try {
        console.log('1. إرسال طلب التحقق من الكابتشا (/i)...');
        const verifyPayload = { [config.captchaField || 'captcha']: captchaCode };
        verifyRes = await client.post(config.verifyCaptchaUrl, verifyPayload);

        // إذا عاد رد ولكن بدون Success
        const isSuccess = verifyRes.data && (verifyRes.data.result === 'Success' || verifyRes.data.success === true);
        if (!isSuccess) {
            return res.json({
                success: false,
                message: 'رمز الكابتشا غير صحيح أو منتهي الصلاحية.',
                step: 'VERIFY_CAPTCHA_FAILED',
                originalResponse: verifyRes.data
            });
        }
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: 'خطأ أثناء التحقق من الكابتشا (فشل الاتصال بمسار /i)',
            step: 'VERIFY_CAPTCHA_ERROR',
            errorDetails: err.response ? err.response.data : err.message
        });
    }

    // الخطوة 2: إنشاء طلب البحث (POST /createRequest)
    let createRes;
    try {
        console.log('2. إرسال طلب إنشاء البحث (/createRequest)...');
        const createPayload = { [config.phoneField || 'phone']: phoneNumber };
        createRes = await client.post(config.createRequestUrl, createPayload);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: 'نجح التحقق من الكابتشا ولكن فشلت خطوة إنشاء طلب البحث (/createRequest)',
            step: 'CREATE_REQUEST_ERROR',
            errorDetails: err.response ? err.response.data : err.message
        });
    }

    // الخطوة 3: جلب التقرير والنتائج (POST /getreport)
    try {
        console.log('3. إرسال طلب جلب التقرير (/getreport)...');
        const reportPayload = { 
            [config.phoneField || 'phone']: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await client.post(config.getReportUrl, reportPayload);

        return res.json({
            success: true,
            data: reportRes.data
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            message: 'نجح إنشاء الطلب ولكن فشل جلب التقرير النهائي (/getreport)',
            step: 'GET_REPORT_ERROR',
            createRequestData: createRes.data,
            errorDetails: err.response ? err.response.data : err.message
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
