package cn.dsh.chatgptmobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.ArrayList;

public class MainActivity extends Activity {

    /** 服务器地址由用户首次启动时填写，存在 SharedPreferences 里 */
    private static final String PREF = "chatpig";
    private static final int REQ_FILE = 1001;
    private static final int REQ_MIC = 2001;

    private String baseUrl = "";
    private String homeHost = "";

    private WebView web;
    private ProgressBar bar;
    private LinearLayout errorView;
    private ValueCallback<Uri[]> pendingFiles;
    private SpeechRecognizer recognizer;
    private boolean pendingSpeechStart = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0e1013"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost();
                // 产物文件（PDF/Word…）交给系统，WebView 自己打不开
                if (host != null && host.equals(homeHost) && u.getPath() != null && u.getPath().startsWith("/media")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                if (host != null && (host.equals(homeHost) || host.equals("login.tailscale.com"))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                web.setVisibility(View.VISIBLE);
                errorView.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || request.isForMainFrame()) showError();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                bar.setProgress(p);
                bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                pendingFiles = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    pendingFiles = null;
                    return false;
                }
            }
        });

        // 网页里的语音按钮优先用这个原生识别（WebView 里没有 webkitSpeechRecognition）
        web.addJavascriptInterface(new SpeechBridge(), "AndroidSpeech");
        // 通知：WebView 里没有 Notification API，走系统通知
        web.addJavascriptInterface(new NotifyBridge(), "AndroidNotify");

        // 下拉刷新：在页面顶部往下拽 180dp 触发
        web.setOnTouchListener(new View.OnTouchListener() {
            float startY;
            boolean armed;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startY = e.getY();
                        armed = !web.canScrollVertically(-1);
                        break;
                    case MotionEvent.ACTION_UP:
                        if (armed && !web.canScrollVertically(-1) && e.getY() - startY > dp(180)) {
                            web.reload();
                        }
                        armed = false;
                        break;
                }
                return false;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        barLp.gravity = Gravity.TOP;
        root.addView(bar, barLp);

        errorView = buildErrorView();
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        loadHome();
    }

    /** 读地址；没配过就先弹框让用户填 */
    private void loadHome() {
        baseUrl = getSharedPreferences(PREF, MODE_PRIVATE).getString("baseUrl", "");
        if (baseUrl.isEmpty()) {
            showUrlDialog();
            return;
        }
        try { homeHost = Uri.parse(baseUrl).getHost(); } catch (Exception e) { homeHost = ""; }
        web.loadUrl(baseUrl);
    }

    private void showUrlDialog() {
        final android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("https://你的机器名.tailnet.ts.net");
        input.setText(baseUrl);
        new android.app.AlertDialog.Builder(this)
                .setTitle("连接哪台电脑")
                .setMessage("填电脑上 ChatPig 的地址：\nTailscale 的 https 域名，或同 Wi-Fi 下的 http://IP:8787")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("连接", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        String u = input.getText().toString().trim();
                        if (u.isEmpty()) return;
                        if (!u.startsWith("http")) u = "https://" + u;
                        if (!u.endsWith("/")) u += "/";
                        getSharedPreferences(PREF, MODE_PRIVATE).edit().putString("baseUrl", u).apply();
                        baseUrl = u;
                        try { homeHost = Uri.parse(u).getHost(); } catch (Exception e) { homeHost = ""; }
                        errorView.setVisibility(View.GONE);
                        web.setVisibility(View.VISIBLE);
                        web.loadUrl(u);
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0e1013"));
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("连不上电脑");
        title.setTextColor(Color.parseColor("#e7e9ee"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView body = new TextView(this);
        body.setText("1. 手机上的 Tailscale 已打开\n2. 电脑没关机，ChatPig 服务在运行\n\n下拉或点下面的按钮重试");
        body.setTextColor(Color.parseColor("#9aa3b2"));
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, dp(14), 0, dp(22));
        box.addView(body);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errorView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                web.reload();
            }
        });
        box.addView(retry);

        Button change = new Button(this);
        change.setText("改服务器地址");
        change.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showUrlDialog();
            }
        });
        box.addView(change);
        return box;
    }

    private void showError() {
        web.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && pendingFiles != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            pendingFiles.onReceiveValue(result);
            pendingFiles = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /* ---------------- 原生通知 ---------------- */

    private static final String CHANNEL_ID = "chatpig";

    public class NotifyBridge {
        @JavascriptInterface
        public void show(final String title, final String body) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    postNotification(title, body);
                }
            });
        }

        /** 网页把地址和 token 交给原生，后台服务自己轮询（App 在后台也能发通知） */
        @JavascriptInterface
        public void startWatch(final String baseUrl, final String token) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent it = new Intent(MainActivity.this, WatchService.class);
                        it.putExtra("baseUrl", baseUrl);
                        it.putExtra("token", token);
                        if (Build.VERSION.SDK_INT >= 26) startForegroundService(it);
                        else startService(it);
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void stopWatch() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { stopService(new Intent(MainActivity.this, WatchService.class)); } catch (Exception ignored) {}
                }
            });
        }
    }

    private void postNotification(String title, String body) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "ChatPig 提醒", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("任务完成、等待批准时提醒");
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle(title == null ? "ChatPig" : title)
                    .setContentText(body == null ? "" : body)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            if (body != null && body.length() > 0) {
                b.setStyle(new Notification.BigTextStyle().bigText(body));
            }
            nm.notify((int) (System.currentTimeMillis() & 0xFFFF), b.build());
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 原生语音识别 ---------------- */

    public class SpeechBridge {
        @JavascriptInterface
        public void start() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        pendingSpeechStart = true;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                        return;
                    }
                    startListening();
                }
            });
        }

        @JavascriptInterface
        public void stop() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (recognizer != null) {
                        try { recognizer.stopListening(); } catch (Exception ignored) {}
                    }
                }
            });
        }
    }

    private void startListening() {
        try {
            if (recognizer == null) {
                recognizer = SpeechRecognizer.createSpeechRecognizer(this);
                recognizer.setRecognitionListener(new RecognitionListener() {
                    public void onReadyForSpeech(Bundle params) {}
                    public void onBeginningOfSpeech() {}
                    public void onRmsChanged(float rmsdB) {}
                    public void onBufferReceived(byte[] buffer) {}
                    public void onEndOfSpeech() {}

                    public void onError(int error) {
                        js("window.onSpeechError && window.onSpeechError(" + jsStr("语音识别失败（" + error + "）") + ")");
                    }

                    public void onResults(Bundle results) {
                        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (list != null && !list.isEmpty()) {
                            js("window.onSpeechResult && window.onSpeechResult(" + jsStr(list.get(0)) + ")");
                        }
                        js("window.onSpeechEnd && window.onSpeechEnd()");
                    }

                    public void onPartialResults(Bundle partialResults) {}
                    public void onEvent(int eventType, Bundle params) {}
                });
            }
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            recognizer.startListening(intent);
        } catch (Exception e) {
            js("window.onSpeechError && window.onSpeechError(" + jsStr("这台手机没有语音识别服务") + ")");
        }
    }

    private void js(String code) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(code, null);
            }
        });
    }

    private String jsStr(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_MIC && pendingSpeechStart) {
            pendingSpeechStart = false;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startListening();
            } else {
                js("window.onSpeechError && window.onSpeechError(" + jsStr("没给麦克风权限") + ")");
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (Exception ignored) {}
            recognizer = null;
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}
