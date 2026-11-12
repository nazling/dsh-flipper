package com.dsh.flipperbridge;

import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.lang.reflect.Method;
import java.util.ArrayDeque;
import java.util.List;
import java.util.UUID;

/**
 * Flipper Zero 的 BLE 串口（serial profile）。
 *
 * 关键点：
 *  - 服务 8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000
 *  - TX（Flipper -> 手机）是 INDICATE，UUID ...62...
 *  - RX（手机 -> Flipper）是 WRITE，UUID ...61...
 *  - 连上 BLE 后固件会自动开一个 RPC 会话，不需要再发 start_rpc_session
 *  - 应用层是透明字节流，RPC 的 varint 分帧由 DSH 插件处理
 */
public class FlipperBle {
    public interface Listener {
        void onBleReady();

        void onBleData(byte[] data);

        void onBleDisconnected();

        void onBleLog(String message);
    }

    private static final UUID SERVICE_UUID =
            UUID.fromString("8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000");
    // 固件 serial_service_uuid.inc 里：TX=...61...（INDICATE），RX=...62...（WRITE）。
    private static final UUID TX_UUID =
            UUID.fromString("19ed82ae-ed21-4c9d-4145-228e61fe0000");
    private static final UUID RX_UUID =
            UUID.fromString("19ed82ae-ed21-4c9d-4145-228e62fe0000");
    private static final UUID CCCD_UUID =
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<byte[]> queue = new ArrayDeque<byte[]>();

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic tx;
    private BluetoothGattCharacteristic rx;
    private volatile boolean ready;
    private boolean writing;
    private int chunkSize = 20;

    public FlipperBle(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    public void connect(BluetoothDevice device) {
        log("GATT 连接 " + device.getAddress() + " …");
        gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) {
            log("connectGatt 返回 null");
        }
    }

    public boolean isReady() {
        return ready;
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                log("GATT 已连接，发现服务…");
                g.discoverServices();
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                ready = false;
                log("GATT 断开（status=" + status + "）");
                listener.onBleDisconnected();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                log("发现服务失败：" + status);
                g.disconnect();
                return;
            }
            BluetoothGattService service = g.getService(SERVICE_UUID);
            if (service == null) {
                log("没找到 Flipper 串口服务，确认 Flipper 的蓝牙已打开且没有被官方 App 占用");
                g.disconnect();
                return;
            }
            tx = service.getCharacteristic(TX_UUID);
            rx = service.getCharacteristic(RX_UUID);
            if (tx == null || rx == null) {
                log("TX/RX 特征缺失");
                g.disconnect();
                return;
            }
            log("TX 属性=" + tx.getProperties() + "，描述符数量=" + tx.getDescriptors().size());
            List<BluetoothGattDescriptor> descriptors = tx.getDescriptors();
            for (BluetoothGattDescriptor descriptor : descriptors) {
                log("TX 描述符 " + descriptor.getUuid());
            }
            boolean ok = g.setCharacteristicNotification(tx, true);
            log("本地开启 TX 指示：" + ok);
            BluetoothGattDescriptor cccd = tx.getDescriptor(CCCD_UUID);
            if (cccd == null) {
                log("CCCD 缺失：请先在系统蓝牙里取消配对 Flipper，关开蓝牙后再重新配对");
                refreshGattCache(g);
                g.disconnect();
                return;
            }
            cccd.setValue(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE);
            if (!g.writeDescriptor(cccd)) {
                log("写 CCCD 失败");
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                log("CCCD 写入失败：" + status);
                return;
            }
            if (CCCD_UUID.equals(descriptor.getUuid())) {
                log("TX 指示已开启");
                ready = true;
                listener.onBleReady();
                log("请求 MTU 247：" + g.requestMtu(247));
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                chunkSize = Math.max(20, mtu - 3);
                log("MTU=" + mtu + "，每包 " + chunkSize + " 字节");
            }
        }

        // API 33 的三参回调默认会转调这个两参版本，所以只覆写它即可。
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic characteristic) {
            if (TX_UUID.equals(characteristic.getUuid())) {
                byte[] value = characteristic.getValue();
                if (value != null && value.length > 0) {
                    listener.onBleData(value);
                }
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic characteristic, int status) {
            if (RX_UUID.equals(characteristic.getUuid())) {
                writing = false;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("BLE 写入失败：" + status);
                }
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        writeNext();
                    }
                });
            }
        }
    };

    /** 从 TCP 线程调用；分片后排队，GATT 同一时刻只允许一个写操作。 */
    public void write(byte[] data) {
        if (!ready) {
            log("BLE 未就绪，丢弃 " + data.length + " 字节");
            return;
        }
        synchronized (queue) {
            int offset = 0;
            while (offset < data.length) {
                int size = Math.min(chunkSize, data.length - offset);
                byte[] chunk = new byte[size];
                System.arraycopy(data, offset, chunk, 0, size);
                queue.add(chunk);
                offset += size;
            }
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                writeNext();
            }
        });
    }

    private void writeNext() {
        if (!ready || writing) {
            return;
        }
        byte[] chunk;
        synchronized (queue) {
            chunk = queue.poll();
        }
        if (chunk == null || gatt == null || rx == null) {
            return;
        }
        writing = true;
        rx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        rx.setValue(chunk);
        boolean queued;
        try {
            queued = gatt.writeCharacteristic(rx);
        } catch (Exception e) {
            queued = false;
        }
        if (!queued) {
            writing = false;
            synchronized (queue) {
                queue.addFirst(chunk);
            }
            log("writeCharacteristic 返回 false");
            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    writeNext();
                }
            }, 50);
        }
    }

    public void close() {
        ready = false;
        synchronized (queue) {
            queue.clear();
        }
        BluetoothGatt current = gatt;
        gatt = null;
        if (current != null) {
            try {
                current.disconnect();
            } catch (Exception ignored) {
            }
            try {
                current.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void refreshGattCache(BluetoothGatt g) {
        try {
            Method method = g.getClass().getMethod("refresh");
            Object result = method.invoke(g);
            log("已请求刷新 GATT 缓存：" + result);
        } catch (Exception e) {
            log("刷新 GATT 缓存失败：" + e.getMessage());
        }
    }

    private void log(String message) {
        listener.onBleLog(message);
    }
}
