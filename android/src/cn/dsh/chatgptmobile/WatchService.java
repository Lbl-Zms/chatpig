package cn.dsh.chatgptmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 后台监视：App 在后台/被冻结时，网页的 JS 停跑，通知就发不出来。
 * 这里用前台服务自己轮询电脑上的 /api/state，发现「任务完成 / 等待批准」就发系统通知。
 */
public class WatchService extends Service {

    static final String CHANNEL_WATCH = "chatpig-watch";
    static final String CHANNEL_ALERT = "chatpig";
    static final int WATCH_ID = 1001;
    static final long INTERVAL_MS = 15000;

    private Handler handler;
    private String baseUrl = "";
    private String token = "";
    private SharedPreferences sp;
    private boolean busy = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            poll();
            handler.postDelayed(this, INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        sp = getSharedPreferences("chatpig", MODE_PRIVATE);
        ensureChannels();
        startForegroundSafe();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String u = intent.getStringExtra("baseUrl");
            String t = intent.getStringExtra("token");
            if (u != null && t != null) {
                baseUrl = u;
                token = t;
                sp.edit().putString("baseUrl", u).putString("token", t).apply();
            }
        }
        if (baseUrl == null || baseUrl.isEmpty()) {
            baseUrl = sp.getString("baseUrl", "");
            token = sp.getString("token", "");
        }
        if (baseUrl.isEmpty() || token.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(tick);
        handler.post(tick);
        return START_STICKY;
    }

    private void startForegroundSafe() {
        try {
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_WATCH)
                    : new Notification.Builder(this);
            b.setContentTitle("ChatPig 正在后台盯着任务")
                    .setContentText("任务完成或需要批准时会通知你")
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setOngoing(true);
            startForeground(WATCH_ID, b.build());
        } catch (Exception ignored) {
        }
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel watch = new NotificationChannel(CHANNEL_WATCH, "ChatPig 后台监视", NotificationManager.IMPORTANCE_MIN);
        watch.setShowBadge(false);
        nm.createNotificationChannel(watch);
        NotificationChannel alert = new NotificationChannel(CHANNEL_ALERT, "ChatPig 提醒", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(alert);
    }

    private void poll() {
        if (busy || baseUrl.isEmpty() || token.isEmpty()) return;
        busy = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(baseUrl + "/api/state?t=" + token);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(10000);
                    conn.setRequestProperty("Accept", "application/json");
                    int code = conn.getResponseCode();
                    if (code != 200) return;
                    StringBuilder sb = new StringBuilder();
                    BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                    r.close();
                    handleState(new JSONObject(sb.toString()));
                } catch (Exception ignored) {
                } finally {
                    if (conn != null) conn.disconnect();
                    busy = false;
                }
            }
        }).start();
    }

    private void handleState(JSONObject s) {
        boolean generating = s.optBoolean("generating", false);
        String title = s.optString("title", "");
        JSONObject approval = s.optJSONObject("pendingApproval");
        String approvalText = approval == null ? "" : approval.optString("text", "");
        JSONArray messages = s.optJSONArray("messages");
        int count = messages == null ? 0 : messages.length();

        boolean prevGenerating = sp.getBoolean("generating", false);
        String prevApproval = sp.getString("approval", "");
        int prevCount = sp.getInt("count", 0);
        String prevTitle = sp.getString("title", "");

        // 新的审批请求
        if (!approvalText.isEmpty() && !approvalText.equals(prevApproval)) {
            post("⚠️ 需要你确认", trim(approvalText, 140));
        }
        // 任务完成
        if (prevGenerating && !generating && count > prevCount) {
            String body = title.isEmpty() ? "电脑上的 ChatGPT 已回复" : title + " — 电脑上的 ChatGPT 已回复";
            post("✅ 任务完成", body);
        }

        sp.edit()
                .putBoolean("generating", generating)
                .putString("approval", approvalText)
                .putInt("count", count)
                .putString("title", title)
                .apply();
    }

    private static String trim(String s, int n) {
        if (s == null) return "";
        s = s.replaceAll("\\s+", " ").trim();
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    private void post(String title, String body) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ALERT)
                    : new Notification.Builder(this);
            b.setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setStyle(new Notification.BigTextStyle().bigText(body));
            nm.notify((int) (System.currentTimeMillis() & 0xFFFF), b.build());
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
