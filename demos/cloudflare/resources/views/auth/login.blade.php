@extends('layouts.auth', ['title' => 'Sign in'])

@section('content')
    <h1>Sign in</h1>
    <p>Authenticate against the users table stored in Cloudflare D1.</p>

    <form method="POST" action="{{ route('login') }}">
        @csrf

        <label for="email">Email</label>
        <input id="email" name="email" type="email" value="{{ old('email') }}" required autofocus autocomplete="email">
        @error('email') <div class="error">{{ $message }}</div> @enderror

        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
        @error('password') <div class="error">{{ $message }}</div> @enderror

        <div class="row">
            <label><input name="remember" type="checkbox"> Remember me</label>
            <button type="submit">Sign in</button>
        </div>
    </form>

    <p class="muted">Need an account? <a href="{{ route('register') }}">Sign up</a></p>
@endsection
