<?php

use App\Http\Controllers\AuthController;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

Route::get('/', function () {
    return view('welcome');
})->name('home');

Route::middleware('guest')->group(function () {
    Route::get('/login', [AuthController::class, 'createLogin'])->name('login');
    Route::post('/login', [AuthController::class, 'login'])
        ->middleware('throttle:6,1');
    Route::get('/register', [AuthController::class, 'createRegister'])->name('register');
    Route::post('/register', [AuthController::class, 'register'])
        ->middleware('throttle:6,1');
});

Route::middleware('auth')->group(function () {
    Route::get('/dashboard', function () {
        return view('dashboard');
    })->name('dashboard');

    Route::post('/logout', [AuthController::class, 'logout'])->name('logout');
});

Route::get('/cloudflare', function () {
    $database = DB::selectOne('SELECT 1 AS connected');

    $cacheKey = 'sst-laravel-demo:'.Str::uuid();
    Cache::put($cacheKey, 'connected', 60);
    $cacheConnected = Cache::get($cacheKey) === 'connected';
    Cache::forget($cacheKey);

    $diskName = config('filesystems.default');
    $disk = Storage::disk($diskName);
    $objectKey = 'sst-laravel-demo/'.Str::uuid().'.txt';

    try {
        $disk->put($objectKey, 'Cloudflare R2 is connected.');
        $storageConnected = $disk->get($objectKey) === 'Cloudflare R2 is connected.';
    } finally {
        $disk->delete($objectKey);
    }

    return response()->json([
        'database' => (int) ($database->connected ?? 0) === 1,
        'cache' => $cacheConnected,
        'storage' => $storageConnected,
        'filesystem' => $diskName,
    ]);
});
