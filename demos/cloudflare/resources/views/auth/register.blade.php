@extends('layouts.auth', ['title' => 'Sign up'])

@section('content')
    <h1>Create an account</h1>
    <p>This writes a user to D1 and starts a database-backed session.</p>

    <form method="POST" action="{{ route('register') }}">
        @csrf

        <label for="name">Name</label>
        <input id="name" name="name" type="text" value="{{ old('name') }}" required autofocus autocomplete="name">
        @error('name') <div class="error">{{ $message }}</div> @enderror

        <label for="email">Email</label>
        <input id="email" name="email" type="email" value="{{ old('email') }}" required autocomplete="email">
        @error('email') <div class="error">{{ $message }}</div> @enderror

        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="new-password">
        @error('password') <div class="error">{{ $message }}</div> @enderror

        <label for="password_confirmation">Confirm password</label>
        <input id="password_confirmation" name="password_confirmation" type="password" required autocomplete="new-password">

        <button type="submit">Sign up</button>
    </form>

    <p class="muted">Already registered? <a href="{{ route('login') }}">Sign in</a></p>
@endsection
