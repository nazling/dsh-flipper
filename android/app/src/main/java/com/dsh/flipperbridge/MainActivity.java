package com.dsh.flipperbridge;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final int REQ_PERM = 41;
    private static final long SCAN_MS = 8000;

    private TextView statusView;
    private TextView logView;
    private EditText portView;
    private Button scanButton;
    private Button stopButton;
    private Button reconnectButton;
    private Button unpairButton;
    private Button clearButton;

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private BluetoothDevice pendingDevice;
    private boolean scanning;

    private final Map<String, ScanResult> found = new LinkedHashMap<String, ScanResult>();
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Runnable logTick = new Runnable() {
        @Override
        public void run() {
            refreshLog();
            handler.postDelayed(this, 500);
        }
    };

    private final Runnable scanTimeout = new Runnable() {
        @Override
        public void run() {
            showPicker();
        }
    };

    private final BroadcastReceiver bondReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(intent.getAction())) {
                return;
            }
            BluetoothDevice device =
                    (BluetoothDevice) intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            int state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1);
            if (device == null) {
                return;
            }
            if (state == BluetoothDevice.BOND_BONDED) {
                LogStore.add("配对完成");
                startBridge(device);
            } else if (state == BluetoothDevice.BOND_NONE) {
                LogStore.add("配对失败或被取消");
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        statusView = (TextView) findViewById(R.id.status);
        logView = (TextView) findViewById(R.id.log);
        portView = (EditText) findViewById(R.id.port);
        scanButton = (Button) findViewById(R.id.scan);
        stopButton = (Button) findViewById(R.id.stop);
        reconnectButton = (Button) findViewById(R.id.reconnect);
        unpairButton = (Button) findViewById(R.id.unpair);
        clearButton = (Button) findViewById(R.id.clear);

        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();

        scanButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startScan();
            }
        });
        stopButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                stopBridge();
            }
        });
        reconnectButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                reconnect();
            }
        });
        unpairButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                unpairAndOpenSettings();
            }
        });
        clearButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                LogStore.clear();
                refreshLog();
            }
        });

        registerReceiver(bondReceiver, new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED));
        handler.post(logTick);
        ensurePermissions();
        showPairingHintOnce();
        LogStore.add("就绪：先开 Flipper 蓝牙，再点“扫描并连接”");
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(logTick);
        handler.removeCallbacks(scanTimeout);
        stopScan();
        try {
            unregisterReceiver(bondReceiver);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    private void showPairingHintOnce() {
        SharedPreferences prefs = getSharedPreferences("flipper", MODE_PRIVATE);
        if (prefs.getBoolean("hint_shown", false)) {
            return;
        }
        prefs.edit().putBoolean("hint_shown", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("配对前提示")
                .setMessage("如果你以前配对过这台 Flipper，请先到系统蓝牙里取消配对，并把蓝牙关开一次，再回来扫描。"
                        + "Android 会复用旧的 GATT 缓存，容易出现 CCCD 缺失、连上了却收不到数据。")
                .setPositiveButton("去蓝牙设置", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        openBluetoothSettings();
                    }
                })
                .setNegativeButton("知道了", null)
                .show();
    }

    private void unpairAndOpenSettings() {
        if (pendingDevice != null) {
            try {
                Method method = pendingDevice.getClass().getMethod("removeBond");
                Object result = method.invoke(pendingDevice);
                LogStore.add("已请求取消配对：" + result);
            } catch (Exception e) {
                LogStore.add("自动取消配对失败：" + e.getMessage() + "，请在系统设置里手动取消");
            }
        } else {
            LogStore.add("还没扫描到设备，直接打开蓝牙设置");
        }
        openBluetoothSettings();
    }

    private void openBluetoothSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS));
        } catch (Exception e) {
            LogStore.add("打不开蓝牙设置：" + e.getMessage());
        }
    }

    private void ensurePermissions() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, REQ_PERM);
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERM) {
            boolean granted =
                    grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            LogStore.add(granted ? "定位权限已给（BLE 扫描需要）" : "没有定位权限，扫描可能搜不到设备");
        }
    }

    private void startScan() {
        if (adapter == null) {
            LogStore.add("这台设备没有蓝牙");
            return;
        }
        if (!adapter.isEnabled()) {
            LogStore.add("蓝牙没开，先打开系统蓝牙");
            return;
        }
        if (scanning) {
            LogStore.add("正在扫描…");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            LogStore.add("BLE 扫描器不可用");
            return;
        }
        found.clear();
        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice device = result.getDevice();
                String name;
                try {
                    name = device.getName();
                } catch (Exception e) {
                    name = null;
                }
                if (isFlipper(result)) {
                    stopScan();
                    final BluetoothDevice target = device;
                    final String label = name == null ? device.getAddress() : name;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            onFound(target, label);
                        }
                    });
                    return;
                }
                if (name != null && name.length() > 0) {
                    synchronized (found) {
                        found.put(device.getAddress(), result);
                    }
                }
            }

            @Override
            public void onScanFailed(int errorCode) {
                LogStore.add("扫描失败：" + errorCode);
            }
        };
        scanning = true;
        try {
            scanner.startScan(scanCallback);
            handler.postDelayed(scanTimeout, SCAN_MS);
            LogStore.add("扫描 " + (SCAN_MS / 1000) + " 秒…没自动认出就列出附近的设备");
        } catch (Exception e) {
            scanning = false;
            LogStore.add("扫描启动失败：" + e.getMessage());
        }
    }

    /** 能自动认出就自动连；认不出就 8 秒后弹列表。 */
    private boolean isFlipper(ScanResult result) {
        ScanRecord record = result.getScanRecord();
        if (record != null) {
            List<ParcelUuid> uuids = record.getServiceUuids();
            if (uuids != null) {
                for (ParcelUuid uuid : uuids) {
                    String text = uuid.getUuid().toString().toLowerCase(Locale.US);
                    // Flipper 广播 16-bit service 0x3080 | color
                    if (text.startsWith("0000308")) {
                        return true;
                    }
                }
            }
        }
        try {
            String name = result.getDevice().getName();
            return name != null && name.toLowerCase(Locale.US).contains("flipper");
        } catch (Exception e) {
            return false;
        }
    }

    private void stopScan() {
        handler.removeCallbacks(scanTimeout);
        if (!scanning) {
            return;
        }
        scanning = false;
        try {
            if (scanner != null && scanCallback != null) {
                scanner.stopScan(scanCallback);
            }
        } catch (Exception ignored) {
        }
        scanCallback = null;
    }

    private void showPicker() {
        stopScan();
        final List<ScanResult> list;
        synchronized (found) {
            list = new ArrayList<ScanResult>(found.values());
        }
        if (list.isEmpty()) {
            LogStore.add("没扫到设备：确认 Flipper 蓝牙已打开、官方 App 没占用、定位已开");
            return;
        }
        String[] labels = new String[list.size()];
        for (int i = 0; i < list.size(); i++) {
            ScanResult result = list.get(i);
            BluetoothDevice device = result.getDevice();
            String name;
            try {
                name = device.getName();
            } catch (Exception e) {
                name = null;
            }
            labels[i] = (name == null ? "(无名设备)" : name)
                    + "\n" + device.getAddress() + "   RSSI " + result.getRssi();
        }
        new AlertDialog.Builder(this)
                .setTitle("选择你的 Flipper")
                .setItems(labels, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        ScanResult result = list.get(which);
                        BluetoothDevice device = result.getDevice();
                        String name;
                        try {
                            name = device.getName();
                        } catch (Exception e) {
                            name = null;
                        }
                        onFound(device, name == null ? device.getAddress() : name);
                    }
                })
                .show();
    }

    private void onFound(BluetoothDevice device, String name) {
        pendingDevice = device;
        LogStore.add("找到 " + name + " (" + device.getAddress() + ")");
        if (device.getBondState() == BluetoothDevice.BOND_BONDED) {
            startBridge(device);
            return;
        }
        LogStore.add("开始配对：Flipper 屏幕会显示 PIN，按系统弹窗输入");
        try {
            if (!device.createBond()) {
                LogStore.add("createBond 返回 false，可能已经在配对中");
            }
        } catch (Exception e) {
            LogStore.add("配对失败：" + e.getMessage());
        }
    }

    private void startBridge(BluetoothDevice device) {
        String text = portView.getText().toString().trim();
        int port;
        try {
            port = Integer.parseInt(text);
        } catch (Exception e) {
            port = 9757;
        }
        if (port < 1 || port > 65535) {
            port = 9757;
        }
        portView.setText(String.valueOf(port));
        Intent intent = new Intent(this, BridgeService.class);
        intent.setAction(BridgeService.ACTION_START);
        intent.putExtra(BridgeService.EXTRA_ADDRESS, device.getAddress());
        intent.putExtra(BridgeService.EXTRA_PORT, port);
        try {
            startService(intent);
            LogStore.add("桥服务已启动，端口 " + port);
        } catch (Exception e) {
            LogStore.add("启动服务失败：" + e.getMessage());
        }
    }

    private void stopBridge() {
        Intent intent = new Intent(this, BridgeService.class);
        intent.setAction(BridgeService.ACTION_STOP);
        try {
            startService(intent);
        } catch (Exception e) {
            LogStore.add("停止服务失败：" + e.getMessage());
        }
    }

    private void reconnect() {
        if (pendingDevice == null) {
            LogStore.add("还没有扫描到设备，先点“扫描并连接”");
            return;
        }
        stopBridge();
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                startBridge(pendingDevice);
            }
        }, 600);
    }

    private void refreshLog() {
        List<String> lines = LogStore.snapshot();
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            builder.append(lines.get(i)).append('\n');
        }
        logView.setText(builder.toString());
        statusView.setText(BridgeService.isRunning
                ? "运行中 · " + portView.getText()
                : "未运行");
    }
}
