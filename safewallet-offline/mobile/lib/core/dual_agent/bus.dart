import 'dart:async';

/// Eventos del bus interno compartido por Centinela-Edge (offline) y Centinela-Net (online).
sealed class BusEvent {
  const BusEvent();
}

class LedgerAppended extends BusEvent {
  const LedgerAppended(this.seq, this.type);
  final int seq;
  final String type;
}

class NetworkChanged extends BusEvent {
  const NetworkChanged(this.online);
  final bool online;
}

class ReconcileFinished extends BusEvent {
  const ReconcileFinished({required this.accepted, required this.chainOk, required this.deviceStatus, required this.settled, required this.declined});
  final int accepted;
  final bool chainOk;
  final String deviceStatus;
  final int settled;
  final int declined;
}

class DoubleSpendDetected extends BusEvent {
  const DoubleSpendDetected(this.reason);
  final String reason;
}

class ShieldActivated extends BusEvent {
  const ShieldActivated(this.trigger, {this.silent = false});
  final String trigger;
  final bool silent;
}

class SilentAlert extends BusEvent {
  const SilentAlert(this.reason);
  final String reason;
}

class RatesUpdated extends BusEvent {
  const RatesUpdated(this.snapshotId);
  final String snapshotId;
}

class AgentError extends BusEvent {
  const AgentError(this.source, this.error);
  final String source;
  final Object error;
}

/// Cola de eventos en memoria (broadcast). El estado durable vive en el WAL cifrado, no en el bus.
class EventBus {
  final StreamController<BusEvent> _c = StreamController<BusEvent>.broadcast(sync: true);
  final List<BusEvent> history = [];

  Stream<BusEvent> get stream => _c.stream;
  Stream<T> on<T extends BusEvent>() => _c.stream.where((e) => e is T).cast<T>();

  void publish(BusEvent e) {
    history.add(e);
    if (!_c.isClosed) _c.add(e);
  }

  Future<void> close() => _c.close();
}
