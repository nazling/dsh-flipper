package com.dsh.flipperbridge;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

/** 前台服务：BLE ↔ TCP 桥，切到后台也不会被系统随便杀。 */
public class BridgeService extends Service implements FlipperBle.Listener, TcpServer.Listener {
    public static final String ACTION_START = "com.dsh.flipperbridge.START";
    public static final String ACTION_STOP = "com.dsh.flipperbridge.STOP";
    public static final String EXTRA_ADDRESS = "address";
    public static final String EXTRA_PORT = "port";

    public static volatile boolean isRunning = false;

    private static final int NOTIFICATION_ID = 7;
    private static final String CHANNEL_ID = "flipper";

    private FlipperBle ble;
    private TcpServer tcp;
    private int port = 9757;
    private String address;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
        startForeground(NOTIFICATION_ID, buildNotification("准备中…"));
    }

    /** targetSdk 25 本来不需要渠道，但 Android 8+ 上显式建一个更稳。 */
    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        try {
            Class<?> channelClass = Class.forName("android.app.NotificationChannel");
            Constructor<?> constructor =
                    channelClass.getConstructor(String.class, CharSequence.class, int.class);
            Object channel = constructor.newInstance(CHANNEL_ID, "Flipper BLE 桥", 2);
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Method method =
                    NotificationManager.class.getMethod("createNotificationChannel", channelClass);
            method.invoke(manager, channel);
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopBridge();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            address = intent.getStringExtra(EXTRA_ADDRESS);
            port = intent.getIntExtra(EXTRA_PORT, 9757);
            startBridge();
        }
        return START_NOT_STICKY;
    }

    private void startBridge() {
        if (isRunning) {
            if (ble != null && ble.isReady()) {
                LogStore.add("桥已经在运行");
                return;
            }
            LogStore.add("上次连接未就绪，重新初始化");
            isRunning = false;
            if (tcp != null) {
                tcp.stop();
                tcp = null;
            }
            if (ble != null) {
                ble.close();
                ble = null;
            }
        }
        if (address == null || address.length() == 0) {
            LogStore.add("没有设备地址");
            return;
        }
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) {
            LogStore.add("没有蓝牙适配器");
            return;
        }
        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(address);
        } catch (Exception e) {
            LogStore.add("设备地址无效：" + address);
            return;
        }
        isRunning = true;
        ble = new FlipperBle(this, this);
        tcp = new TcpServer(port, this);
        LogStore.add("连接 " + safeName(device) + " …");
        ble.connect(device);
    }

    private void stopBridge() {
        isRunning = false;
        if (tcp != null) {
            tcp.stop();
            tcp = null;
        }
        if (ble != null) {
            ble.close();
            ble = null;
        }
        updateNotification("已停止");
        LogStore.add("桥已停止");
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder = new Notification.Builder(this)
                .setContentTitle("Flipper BLE 桥")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Method setChannel =
                        Notification.Builder.class.getMethod("setChannelId", String.class);
                setChannel.invoke(builder, CHANNEL_ID);
            } catch (Exception ignored) {
            }
        }
        return builder.build();
    }

    private void updateNotification(String text) {
        try {
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, buildNotification(text));
            }
        } catch (Exception ignored) {
        }
    }

    private static String safeName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null ? device.getAddress() : name + " (" + device.getAddress() + ")";
        } catch (Exception e) {
            return device.getAddress();
        }
    }

    // ---- FlipperBle.Listener ----

    @Override
    public void onBleReady() {
        LogStore.add("BLE 已就绪，启动 TCP 桥");
        if (tcp != null) {
            tcp.start();
        }
        updateNotification("监听 127.0.0.1:" + port);
    }

    @Override
    public void onBleData(byte[] data) {
        if (tcp != null) {
            tcp.sendToClient(data);
        }
    }

    @Override
    public void onBleDisconnected() {
        LogStore.add("BLE 断开，可点“重新连接”");
        isRunning = false;
        if (tcp != null) {
            tcp.stop();
            tcp = null;
        }
        ble = null;
        updateNotification("BLE 断开");
    }

    @Override
    public void onBleLog(String message) {
        LogStore.add(message);
    }

    // ---- TcpServer.Listener ----

    @Override
    public void onTcpData(byte[] data) {
        if (ble != null) {
            ble.write(data);
        }
    }

    @Override
    public void onTcpLog(String message) {
        LogStore.add(message);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopBridge();
        super.onDestroy();
    }
}
