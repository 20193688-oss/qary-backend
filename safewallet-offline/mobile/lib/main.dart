import 'package:flutter/material.dart';

import 'app/app_controller.dart';
import 'app/screens.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(SafeWalletApp(controller: AppController()));
}
